import React from 'react';
import * as Docs from '../../wallet/docs';
import { useCoins, getSpendingClaimables } from '../../state/wallet';
import { Link } from 'react-router-dom';
import * as mp from 'moneypot-lib';

export default function Coins() {
  const coins = useCoins();

  return (
    <div>
      <h1>Coins ({coins.length})</h1>
      <table style={{ borderSpacing: '3px', borderCollapse: 'separate' }}>
        <thead>
          <tr>
            <th>Status</th>
            <th>Ack'd?</th>
            <th>Owner</th>
            <th>Magnitude</th>
            <th>ClaimHash</th>
          </tr>
        </thead>
        <tbody>
          {coins.map(coin => (
            <ClaimedCoin key={coin.owner} coin={coin} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// weird variation in speed, tested w/ 500 coins. TODO: benchmark a bit more
function ClaimedCoin({ coin }: { coin: Docs.Coin }) {
  // const claimableInputs = getAllClaimables().filter(function(spend: { kind: string }) {
  //   //fixed ln errors
  //   return spend.kind != 'Hookin' && spend.kind != "LightningInvoice";
  // });

  const claimableInputs = getSpendingClaimables();

  const spendInClaimable = (pubkey: string): mp.Hash | string => {
    for (const c of claimableInputs) {
      const e = c.inputs;
      for (const k of e) {
        if (pubkey === k.owner) {
          return c.hash;
        }
      }
    }
    // for (let i = 0; i < claimableInputs.length; i++) {
    //   const element = claimableInputs[i].inputs;
    //   const claimable = claimableInputs[i];
    //   for (let i = 0; i < element.length; i++) {
    //     if (pubkey === element[i].owner) {
    //       return claimable.hash;
    //     }
    //   }
    // }
    return 'not spent';
  };
  const ack = (pubkey: string): string => {
    for (const c of claimableInputs) {
      const e = c.inputs;
      for (const k of e) {
        if (pubkey === k.owner) {
          if (c.acknowledgement != undefined) {
            return 'ackd';
          }
          return 'not ackd';
        }
      }
    }
    // for (let i = 0; i < claimableInputs.length; i++) {
    //   const element = claimableInputs[i].inputs;
    //   const claimable = claimableInputs[i];
    //   for (let i = 0; i < element.length; i++) {
    //     if (pubkey === element[i].owner) {
    //       if (claimable.acknowledgement != undefined) {
    //         return "ack'd";
    //       }
    //       return "not ack'd";
    //     }
    //   }
    // }
    return '';
  };

  return (
    <tr>
      <td>
        <code>
          <Link to={`/claimables/${spendInClaimable(coin.owner)}`}>
            {spendInClaimable(coin.owner) === 'not spent' ? 'not spent' : 'Coins have been spent in... '}
          </Link>
        </code>
      </td>
      <td>{ack(coin.owner)}</td>
      <td>
        <code>{coin.owner}</code>
      </td>
      <td>{coin.magnitude}</td>
      <td>
        <code>
          <Link to={`/claimables/${coin.claimableHash}`}>{coin.claimableHash}</Link>
        </code>
      </td>
    </tr>
  );
}