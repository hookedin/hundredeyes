import Dexie from 'dexie';
import * as Docs from './docs';
import * as hi from 'hookedin-lib';
import * as util from '../util';

import * as bip39 from '../bip39';

import HIChain from './hichain';
import 'dexie-observable';

import submitTransfer from './requests/submit-transfer';
import { RequestError } from './requests/make-request';
import makeClaim from './requests/make-claim';

import fetchBitcoinReceives, { BitcoinReceiveInfo } from './requests/bitcoin-receives';
import EventEmitter from './event-emitter';
import * as coinselection from './coin-selection';
import { DatabaseChangeType } from 'dexie-observable/api';
import lookupCoin from './requests/lookup-coin';
import lookupTransfer from './requests/lookup-transfer';
import lookupBountiesByClaimant from './requests/lookup-bounties-by-claimant';

export default class Database extends EventEmitter {
  db: Dexie;

  bounties: Dexie.Table<Docs.Bounty, string>;
  config: Dexie.Table<Docs.Config, 1>;
  claims: Dexie.Table<Docs.Claim, string>;
  coins: Dexie.Table<Docs.Coin, string>;
  hookins: Dexie.Table<Docs.Hookin, string>;
  bitcoinAddresses: Dexie.Table<Docs.BitcoinAddress, string>;
  directAddresses: Dexie.Table<Docs.DirectAddress, string>;
  hookouts: Dexie.Table<Docs.Hookout, string>;
  transfers: Dexie.Table<Docs.Transfer, string>;

  seed: Uint8Array | undefined; // if not set, wallet is locked.

  constructor(name: string) {
    super();

    this.db = new Dexie(name);
    this.db.version(1).stores({
      bitcoinAddresses: 'address, &index',
      // All bounties are from the server, unless it's attached to a transfer that's PENDING | CONFLICTED
      // we can have bounties that we can't claim (since they're not ours as we don't have the directAddress)
      bounties: 'hash, claimant',
      config: 'one',
      coins: 'hash, claimHash',
      claims: 'claimRequest.claim', // is the claimHash...
      directAddresses: 'claimant, &index',
      hookins: 'hash, bitcoinAddress',
      hookouts: 'hash',
      transfers: 'hash, input, *coinHashes, output, kind, status.kind, created',
    });

    this.bounties = this.db.table('bounties');
    this.bitcoinAddresses = this.db.table('bitcoinAddresses');
    this.config = this.db.table('config');
    this.claims = this.db.table('claims');
    this.coins = this.db.table('coins');
    this.directAddresses = this.db.table('directAddresses');
    this.hookins = this.db.table('hookins');
    this.hookouts = this.db.table('hookouts');
    this.transfers = this.db.table('transfers');

    this.seed = undefined;

    this.db.on('changes', changes => {
      for (const change of changes) {
        console.log('Got db change: ', change);

        this.emit(`table:${change.table}`);
        this.emit(`key:${change.key}`);

        const obj = change.type === DatabaseChangeType.Delete ? (change as any).oldObj : (change as any).obj;

        if (change.table === 'bounties') {
          this.emit(`bounties.claimant:${obj.claimant}`);
        }

        if (change.table === 'hookins') {
          this.emit(`hookins.bitcoinAddress:${obj.bitcoinAddress}`);
        }

        if (change.table === 'transfers') {
          for (const coinHash of obj.coinHashes) {
            this.emit(`transfers.coinHashes:${coinHash}`);
          }
          this.emit(`transfers.output:${obj.output}`);
        }
      }
    });
  }

  public static async restore(name: string, mnemonic: string, password: string): Promise<Database | Error> {
    const db = new Database(name);

    const isCorrect = bip39.validateMnemonic(mnemonic);
    if (!isCorrect) {
      return new Error('INVALID_MNEMONIC');
    }

    const seed = await bip39.mnemonicToSeed(mnemonic, password);

    const bitcoinAddressGenerator = seedToBitcoinAddressGenerator(seed);
    const directAddressGenerator = seedToDirectAddressGenerator(seed);
    const internalAddressGenerator = seedToInternalAddressGenerator(seed);

    const configDoc: Docs.Config = {
      one: 1,
      bitcoinAddressGenerator: bitcoinAddressGenerator.toPublicKey().toPOD(),
      directAddressGenerator: directAddressGenerator.toPublicKey().toPOD(),
      internalAddressGenerator: internalAddressGenerator.toPublicKey().toPOD(),
      mnemonic,
      baseAPI: true ? 'https://www.hookedin.com/api/dev' : 'http://localhost:3030',
      gapLimit: 10,
    };

    try {
      await db.config.add(configDoc);
    } catch (err) {
      console.error('got error when trying to restore a config', err);
      return new Error('WALLET_ALREADY_INITIALIZED');
    }
    db.seed = seed;

    return db;
  }

  public static async create(name: string, password: string): Promise<Database | Error> {
    const mnemonic = bip39.generateMnemonic();
    return await Database.restore(name, mnemonic, password);
  }

  public async unlock(password: string): Promise<Error | undefined> {
    const config = await this.getConfig();

    const seed = await bip39.mnemonicToSeed(config.mnemonic, password);
    const addressGenerator = seedToBitcoinAddressGenerator(seed);

    if (addressGenerator.toPublicKey().toPOD() !== config.bitcoinAddressGenerator) {
      return new Error('INVALID_PASSWORD');
    }

    this.seed = seed;
  }

  // must be called inside a transaction (directAddresses, bounties)
  public async newInternalBounty(amount: number): Promise<[hi.Bounty, Docs.Bounty]> {
    const maxIndex = await this.directAddresses.orderBy('index').last();
    const index = maxIndex === undefined ? 0 : maxIndex.index + 1;

    const [claimant, address] = await this.addDirectAddress(index, true);
    const nonce = hi.random(32);

    const bounty = new hi.Bounty(amount, claimant, nonce);

    const doc: Docs.Bounty = {
      hash: bounty.hash().toPOD(),
      ...bounty.toPOD(),
    };

    await this.bounties.add(doc);

    return [bounty, doc];
  }

  private async processClaimResponse(acknowledgedClaimResponse: hi.AcknowledgedClaimResponse) {
    // basically just adds the appropriate coins, and adds the claim

    this.db.transaction('rw', this.coins, this.claims, async () => {
      const claimResponse = acknowledgedClaimResponse.contents;
      const { claimRequest, blindedReceipts } = claimResponse;

      const claimHash = claimRequest.claim;

      util.mustEqual(claimRequest.coins.length, blindedReceipts.length);

      for (let i = 0; i < claimRequest.coins.length; i++) {
        const coinClaim = claimRequest.coins[i];
        const blindedExistenceProof = blindedReceipts[i];

        const blindingSecret = this.deriveBlindingSecret(claimHash, coinClaim.blindingNonce);
        const newOwner = this.deriveOwner(claimHash, coinClaim.blindingNonce).toPublicKey();

        const signer = hi.Params.blindingCoinPublicKeys[coinClaim.magnitude.n];

        const [unblinder, blindedOwner] = hi.blindMessage(blindingSecret, coinClaim.blindingNonce, signer, newOwner.buffer);

        util.mustEqual(blindedOwner.toPOD(), coinClaim.blindedOwner.toPOD());

        const existenceProof = hi.unblind(unblinder, blindedExistenceProof);

        util.mustEqual(existenceProof.verify(newOwner.buffer, signer), true);

        const coin = new hi.Coin(newOwner, coinClaim.magnitude, existenceProof);

        await this.coins.put({
          hash: coin.hash().toPOD(),
          claimHash: claimHash.toPOD(),
          blindingNonce: coinClaim.blindingNonce.toPOD(),
          ...coin.toPOD(),
        });
      }

      await this.claims.put({
        ...acknowledgedClaimResponse.toPOD(),
      });
    });

    // TODO: validate ...
  }

  public async claimBounty(bountyDoc: Docs.Bounty) {
    const address = util.mustExist(await this.directAddresses.get(bountyDoc.claimant));
    return this.claimBountyWithAddress(bountyDoc, address);
  }

  private async claimBountyWithAddress(bountyDoc: Docs.Bounty, address: Docs.DirectAddress) {
    const claim = await this.claims.get(bountyDoc.hash);
    if (claim) {
      console.log('bounty: ', bountyDoc.hash, ' already claimed, no need to reclaim', claim);
      return;
    }

    const claimant = this.deriveClaimantIndex(address.index, address.isInternal);

    const bounty = util.notError(hi.Bounty.fromPOD(bountyDoc));

    const magnitudes = hi.amountToMagnitudes(bounty.amount);

    const claimResponse = await makeClaim(this.deriveBlindingSecret.bind(this), this.deriveOwner.bind(this), claimant, bounty, magnitudes);

    await this.processClaimResponse(claimResponse);
  }

  public async claimHookin(hookinDoc: Docs.Hookin) {
    const claim = await this.claims.get(hookinDoc.hash);
    if (claim) {
      console.log('hookin: ', hookinDoc.hash, ' already claimed, no need to reclaim', claim);
      return;
    }

    const bitcoinAddressDoc = util.mustExist(await this.bitcoinAddresses.get(hookinDoc.bitcoinAddress));

    const { claimant } = this.deriveBitcoinAddressIndex(bitcoinAddressDoc.index);

    const hookin = util.notError(hi.Hookin.fromPOD(hookinDoc));

    const magnitudes = hi.amountToMagnitudes(hookin.amount - hi.Params.transactionConsolidationFee);

    const claimResponse = await makeClaim(this.deriveBlindingSecret.bind(this), this.deriveOwner.bind(this), claimant, hookin, magnitudes);

    await this.processClaimResponse(claimResponse);
  }

  public async reset() {
    for (const table of this.db.tables) {
      if (table.name === 'config' || table.name[0] === '_') {
        console.log('skipping clearing table: ', table.name);
        continue;
      }
      console.log('clearing table: ', table.name);
      await table.clear();
    }
  }

  public async listUnspent(): Promise<Docs.Coin[]> {
    const spentTransfers = await this.transfers
      .where('status.kind')
      .notEqual('CONFLICTED')
      .toArray();

    const spentCoinHashes: Set<string> = new Set();

    for (const transfer of spentTransfers) {
      for (const hash of transfer.coinHashes) {
        spentCoinHashes.add(hash);
      }
    }

    return await this.coins.filter(coin => !spentCoinHashes.has(coin.hash)).toArray();
  }

  public async getBalance() {
    const coins = await this.listUnspent();

    let sum = 0;
    for (const coin of coins) {
      sum += 2 ** coin.magnitude;
    }

    return sum;
  }

  public async syncBitcoinAddresses() {
    const { gapLimit } = await this.getConfig();
    let gapCount = 0;

    const addresses = await this.bitcoinAddresses.orderBy('index').toArray();
    for (const address of addresses) {
      const used = await this.checkBitcoinAddress(address);

      gapCount = used ? 0 : gapCount + 1;
    }

    let lastAddressIndex = addresses.length > 0 ? addresses[addresses.length - 1].index : -1;

    for (let checkIndex = lastAddressIndex + 1; gapCount < gapLimit; checkIndex++) {
      const { bitcoinAddress } = this.deriveBitcoinAddressIndex(checkIndex);
      console.log('prechecking: ', bitcoinAddress);
      const receives = await fetchBitcoinReceives(bitcoinAddress);

      if (receives.length > 0) {
        console.log('found: ', bitcoinAddress, ' has some hookins: ', receives.length);

        // Add all missing addresses...
        for (let addIndex = checkIndex - 1; addIndex > lastAddressIndex; addIndex--) {
          console.log('adding skipped bitcoin address: ', addIndex);
          await this.addBitcoinAddress(addIndex);
        }

        const bitcoinAddressDoc = await this.addBitcoinAddress(checkIndex);
        await this.addHookins(bitcoinAddressDoc, receives);
        lastAddressIndex = checkIndex;
        gapCount = 0;
      } else {
        gapCount++;
      }
    }
  }

  public async sync() {
    await this.syncBitcoinAddresses();
    await this.syncHookins();

    // TODO: find coins that are funded...
  }

  async syncHookins() {
    const allClaims = await this.claims.toArray();

    const allClaimed = new Set<string>();
    for (const claim of allClaims) {
      allClaimed.add(claim.claimRequest.claim);
    }

    const unclaimedHookins = await this.hookins.filter(hookin => !allClaimed.has(hookin.hash)).toArray();
    console.log('Claiming: ', unclaimedHookins.length, ' hookins');

    for (const hookin of unclaimedHookins) {
      await this.claimHookin(hookin);
    }
  }

  async getUnusedBitcoinAddress(): Promise<Docs.BitcoinAddress> {
    return await this.db.transaction('rw', this.bitcoinAddresses, this.hookins, async () => {
      const bitcoinAddress = await this.bitcoinAddresses
        .orderBy('index')
        .reverse()
        .first();

      if (bitcoinAddress) {
        const hookinCount = await this.hookins.where({ bitcoinAddress: bitcoinAddress.address }).count();
        if (hookinCount > 0) {
          return await this.addBitcoinAddress(bitcoinAddress.index + 1);
        } else {
          return bitcoinAddress;
        }
      } else {
        return await this.addBitcoinAddress(0);
      }
    });
  }

  public async newBitcoinAddress(): Promise<Docs.BitcoinAddress> {
    return await this.db.transaction('rw', this.bitcoinAddresses, async () => {
      const maxIndex = await this.bitcoinAddresses.orderBy('index').last();
      const index = maxIndex === undefined ? 0 : maxIndex.index + 1;

      return this.addBitcoinAddress(index);
    });
  }

  private async addBitcoinAddress(index: number): Promise<Docs.BitcoinAddress> {
    const hookinInfo = this.deriveBitcoinAddressIndex(index);

    const claimant = hookinInfo.claimant.toPublicKey().toPOD();
    const bitcoinAddress = hookinInfo.bitcoinAddress;

    const bitcoinAddressDoc: Docs.BitcoinAddress = {
      address: bitcoinAddress,
      claimant,
      index,
    };

    await this.bitcoinAddresses.put(bitcoinAddressDoc);

    return bitcoinAddressDoc;
  }

  // return if used or not
  public async checkBitcoinAddress(bitcoinAddressDoc: Docs.BitcoinAddress): Promise<boolean> {
    const receives = await fetchBitcoinReceives(bitcoinAddressDoc.address);

    await this.addHookins(bitcoinAddressDoc, receives);

    return receives.length > 0;
  }

  async getUnusedDirectAddress(): Promise<Docs.DirectAddress> {
    return await this.db.transaction('rw', this.directAddresses, this.bounties, async () => {
      const directAddress = await this.directAddresses
        .orderBy('index')
        .reverse()
        .first();

      if (directAddress) {
        const bountyCount = await this.bounties.where({ claimant: directAddress.claimant }).count();
        if (bountyCount > 0) {
          return (await this.addDirectAddress(directAddress.index + 1, false))[1];
        } else {
          return directAddress;
        }
      } else {
        return (await this.addDirectAddress(0, false))[1];
      }
    });
  }

  async newDirectAddress() {
    return await this.db.transaction('rw', this.directAddresses, async () => {
      const maxIndex = await this.directAddresses.orderBy('index').last();
      const index = maxIndex === undefined ? 0 : maxIndex.index + 1;

      return this.addDirectAddress(index, false);
    });
  }

  private async addDirectAddress(index: number, isInternal: boolean): Promise<[hi.PublicKey, Docs.DirectAddress]> {
    const claimant = this.deriveClaimantIndex(index, isInternal);
    const claimantPub = claimant.toPublicKey();

    const directAddressDoc: Docs.DirectAddress = {
      claimant: claimantPub.toPOD(),
      index,
      isInternal,
    };

    await this.directAddresses.put(directAddressDoc);

    return [claimantPub, directAddressDoc];
  }

  public async checkDirectAddress(directAddressDoc: Docs.DirectAddress) {
    const bounties = await lookupBountiesByClaimant(directAddressDoc.claimant);

    for (const b of bounties) {
      const bounty = util.notError(hi.Bounty.fromPOD(b));

      const bountyDoc: Docs.Bounty = {
        hash: bounty.hash().toPOD(),
        ...bounty.toPOD(),
      };

      await this.bounties.add(bountyDoc);
      await this.claimBountyWithAddress(bountyDoc, directAddressDoc);
    }
  }

  public async addHookins(bitcoinAddressDoc: Docs.BitcoinAddress, receives: BitcoinReceiveInfo[]) {
    for (const receive of receives) {
      const creditToPub = util.notError(hi.PublicKey.fromPOD(bitcoinAddressDoc.claimant));

      const hookin = new hi.Hookin(receive.txid, receive.vout, receive.amount, creditToPub);

      let hookinDoc: Docs.Hookin = {
        hash: hookin.hash().toPOD(),
        bitcoinAddress: bitcoinAddressDoc.address,
        created: new Date(),
        ...hookin.toPOD(),
      };

      await this.hookins.put(hookinDoc);

      await this.claimHookin(hookinDoc);
    }
  }

  async getConfig() {
    const config = await this.config.get(1);
    return util.mustExist(config);
  }

  async discardTransfer(transferDoc: Docs.Transfer) {
    if (transferDoc.status.kind !== 'PENDING') {
      throw new Error('transfer must be pending');
    }

    console.warn('discarding transfer: ', transferDoc.hash);
    transferDoc.status = { kind: 'CONFLICTED' };
    this.transfers.put(transferDoc);
  }

  async finalizeTransfer(transferDoc: Docs.Transfer): Promise<void> {
    if (transferDoc.status.kind !== 'PENDING') {
      throw new Error('transfer must be pending');
    }

    const inputs = transferDoc.inputs.map(i => util.notError(hi.Coin.fromPOD(i)));

    const bountyDocs: Docs.Bounty[] = [];
    for (const bountyHash of transferDoc.bountyHashes) {
      const b = util.mustExist(await this.bounties.get(bountyHash));
      bountyDocs.push(b);
    }

    let hookout: hi.Hookout | undefined = undefined;
    if (transferDoc.hookoutHash) {
      const h = util.mustExist(await this.hookouts.get(transferDoc.hookoutHash));
      hookout = util.notError(hi.Hookout.fromPOD(h));
    }

    const authorization = util.notError(hi.Signature.fromPOD(transferDoc.authorization));

    const fullTransfer = new hi.FullTransfer(inputs, bountyDocs.map(b => util.notError(hi.Bounty.fromPOD(b))), hookout, authorization);
    const acknowledgement = await submitTransfer(fullTransfer);

    if (acknowledgement instanceof RequestError) {
      if (acknowledgement.message === 'INPUT_SPENT') {
        // Let's loop over all the inputs to try find the one...
        for (const coin of transferDoc.inputs) {
          const transferHash = await lookupCoin(coin.owner);
          if (transferHash === undefined) {
            continue; // hasn't been spent..
          }

          // TODO(optimize) we can check if we already have the (ack'd) transfer

          const conflictTransfer = await lookupTransfer(transferHash);
          if (conflictTransfer === undefined) {
            console.warn('could not find transfer', transferHash, ' even though the server told us about it');
            continue;
          }

          const conflictTransferDoc: Docs.Transfer = {
            hash: conflictTransfer.hash().toPOD(),
            created: new Date(),
            status: { kind: 'ACKNOWLEDGED', acknowledgement: conflictTransfer.acknowledgement.toPOD() },
            coinHashes: conflictTransfer.contents.inputs.map(coin => coin.hash().toPOD()),
            ...conflictTransfer.toPOD(),
          };
          await this.transfers.put(conflictTransferDoc);
        }

        transferDoc.status = { kind: 'CONFLICTED' };
        this.transfers.put(transferDoc);
      }

      console.error('Got other server error: ', acknowledgement);
      throw acknowledgement;
    }

    // succeeded. So in the background, we should be trying to claim all the bounties

    (async () => {
      for (const bounty of bountyDocs) {
        const address = await this.directAddresses.get(bounty.claimant);
        if (address === undefined) {
          continue;
        }
        await this.claimBountyWithAddress(bounty, address);
      }
    })().catch(err => {
      console.error('could not claim bounties, got error: ', err);
    });

    transferDoc.status = { kind: 'ACKNOWLEDGED', acknowledgement: acknowledgement.toPOD() };
    await this.transfers.put(transferDoc);
  }

  public async sendDirect(to: hi.PublicKey, amount: number): Promise<'NOT_ENOUGH_FUNDS' | hi.Hash> {
    util.mustEqual(amount > 0, true);

    const totalToSend = amount + hi.Params.basicTransferFee;

    const res = await this.db.transaction('rw', this.bounties, this.coins, this.directAddresses, this.transfers, async () => {
      const unspent = await this.listUnspent();

      const coinsToUse = coinselection.findAtLeast(unspent, totalToSend);
      if (!coinsToUse) {
        return 'NOT_ENOUGH_FUNDS';
      }

      const bounty = new hi.Bounty(amount, to, hi.random(32));
      const bountyDoc: Docs.Bounty = {
        hash: bounty.hash().toPOD(),
        ...bounty.toPOD(),
      };
      await this.bounties.add(bountyDoc);

      const bounties = [bounty];

      if (coinsToUse.excess > 0) {
        const [changeBounty, changeBountyDoc] = await this.newInternalBounty(coinsToUse.excess);
        bounties.push(changeBounty);
      }
      hi.Transfer.sort(bounties);

      const inputs = coinsToUse.found.map(coin => util.notError(hi.Coin.fromPOD(coin)));
      hi.Transfer.sort(inputs);

      const transferHash = hi.Transfer.hashOf(inputs.map(i => i.hash()), bounties.map(b => b.hash()), undefined);

      const owners: hi.PrivateKey[] = [];

      for (const coin of inputs) {
        const coinDoc = util.mustExist(await this.coins.get(coin.hash().toPOD()));
        const claimHash = util.notError(hi.Hash.fromPOD(coinDoc.claimHash));
        const blindingNonce = util.notError(hi.PublicKey.fromPOD(coinDoc.blindingNonce));
        owners.push(this.deriveOwner(claimHash, blindingNonce));
      }

      const sig = hi.Signature.computeMu(transferHash.buffer, owners);

      const transfer = new hi.FullTransfer(inputs, bounties, undefined, sig);

      const transferDoc: Docs.Transfer = {
        hash: transfer.hash().toPOD(),
        status: { kind: 'PENDING' },
        created: new Date(),
        coinHashes: transfer.inputs.map(coin => coin.hash().toPOD()),
        ...transfer.prune().toPOD(),
      };

      await this.transfers.add(transferDoc);

      return { bountyDoc, transferDoc, transferHash };
    });

    if (res === 'NOT_ENOUGH_FUNDS') {
      return res;
    }

    await this.finalizeTransfer(res.transferDoc);
    return res.transferHash;
  }

  public async sendToBitcoinAddress(address: string, amount: number, feeRate: number): Promise<'NOT_ENOUGH_FUNDS' | hi.Hash> {
    const totalToSend = amount + Math.ceil(feeRate * hi.Params.templateTransactionWeight);

    const res = await this.db.transaction('rw', this.bounties, this.coins, this.directAddresses, this.hookouts, this.transfers, async () => {
      const unspent = await this.listUnspent();

      const coinsToUse = coinselection.findAtLeast(unspent, totalToSend);
      if (!coinsToUse) {
        return 'NOT_ENOUGH_FUNDS';
      }

      const hookout = new hi.Hookout(amount, address, true, hi.random(32));
      const hookoutDoc: Docs.Hookout = {
        hash: hookout.hash().toPOD(),
        ...hookout.toPOD(),
      };
      await this.hookouts.add(hookoutDoc);

      const bounties = [];

      if (coinsToUse.excess > 0) {
        const [changeBounty, changeBountyDoc] = await this.newInternalBounty(coinsToUse.excess);
        bounties.push(changeBounty);
      }

      const inputs = coinsToUse.found.map(coin => util.notError(hi.Coin.fromPOD(coin)));
      hi.Transfer.sort(inputs);

      const transferHash = hi.Transfer.hashOf(inputs.map(i => i.hash()), bounties.map(b => b.hash()), hookout.hash());

      const owners: hi.PrivateKey[] = [];

      for (const coin of inputs) {
        const coinDoc = util.mustExist(await this.coins.get(coin.hash().toPOD()));
        const claimHash = util.notError(hi.Hash.fromPOD(coinDoc.claimHash));
        const blindingNonce = util.notError(hi.PublicKey.fromPOD(coinDoc.blindingNonce));
        owners.push(this.deriveOwner(claimHash, blindingNonce));
      }

      const auth = hi.Signature.computeMu(transferHash.buffer, owners);

      const transfer = new hi.FullTransfer(inputs, bounties, hookout, auth);

      if (!transfer.isValid()) {
        console.error('transfer hash is: ', transfer.hash().toPOD(), ' and expected: ', transferHash.toPOD());
        throw new Error('just created transfer is not valid');
      }

      const transferDoc: Docs.Transfer = {
        hash: transferHash.toPOD(),
        ...transfer.prune().toPOD(),
        created: new Date(),
        coinHashes: transfer.inputs.map(coin => coin.hash().toPOD()),
        status: { kind: 'PENDING' },
      };
      await this.transfers.add(transferDoc);

      return { transferDoc, transferHash };
    });

    if (res === 'NOT_ENOUGH_FUNDS') {
      return res;
    }

    await this.finalizeTransfer(res.transferDoc);
    return res.transferHash;
  }

  public deriveBitcoinAddressIndex(i: number) {
    return this.deriveBitcoinAddress(hi.Buffutils.fromUint8(i)); // TODO: use .fromVarInt()
  }

  public deriveBitcoinAddress(n: Uint8Array) {
    if (this.seed === undefined) {
      throw new Error('wallet is locked');
    }

    const claimant = seedToBitcoinAddressGenerator(this.seed).derive(n);
    const claimantPub = claimant.toPublicKey();

    const tweakBytes = hi.Hash.fromMessage('tweak', claimantPub.buffer).buffer;
    const tweak = util.notError(hi.PrivateKey.fromBytes(tweakBytes));

    const tweakPubkey = tweak.toPublicKey();

    const pubkey = hi.Params.fundingPublicKey.tweak(tweakPubkey);

    return { claimant, bitcoinAddress: pubkey.toBitcoinAddress() };
  }

  public deriveClaimantIndex(index: number, isInternal: boolean) {
    return this.deriveClaimant(hi.Buffutils.fromVarInt(index), isInternal);
  }

  public deriveClaimant(n: Uint8Array, isInternal: boolean): hi.PrivateKey {
    if (this.seed === undefined) {
      throw new Error('wallet is locked');
    }

    const addressGenerator = isInternal ? seedToDirectAddressGenerator(this.seed) : seedToInternalAddressGenerator(this.seed);

    return addressGenerator.derive(n);
  }

  public deriveOwner(claimHash: hi.Hash, blindingNonce: hi.PublicKey): hi.PrivateKey {
    if (this.seed === undefined) {
      throw new Error('wallet is locked');
    }

    const hash = hi.Hash.fromMessage('HIChain.deriveOwner', this.seed, claimHash.buffer, blindingNonce.buffer);

    return util.notError(hi.PrivateKey.fromBytes(hash.buffer));
  }

  public deriveBlindingSecret(claimHash: hi.Hash, blindingNonce: hi.PublicKey): Uint8Array {
    if (this.seed === undefined) {
      throw new Error('wallet is locked');
    }

    const hash = hi.Hash.fromMessage('HIChain.deriveBlindingSecret', this.seed, claimHash.buffer, blindingNonce.buffer);
    return hash.buffer;
  }
}

function seedToBitcoinAddressGenerator(seed: Uint8Array): hi.PrivateKey {
  const hash = hi.Hash.fromMessage('bitcoinAddressGenerator', seed);
  return util.notError(hi.PrivateKey.fromBytes(hash.buffer));
}

function seedToDirectAddressGenerator(seed: Uint8Array): hi.PrivateKey {
  const hash = hi.Hash.fromMessage('directAddressGenerator', seed);
  return util.notError(hi.PrivateKey.fromBytes(hash.buffer));
}

function seedToInternalAddressGenerator(seed: Uint8Array): hi.PrivateKey {
  const hash = hi.Hash.fromMessage('internalAddressGenerator', seed);
  return util.notError(hi.PrivateKey.fromBytes(hash.buffer));
}
