import React from 'react';
import { Link } from 'react-router-dom';

import { wallet, useClaimStatus } from '../state/wallet';

import * as Docs from '../wallet/docs';

export default function HookinsTable({ hookins }: { hookins: Docs.Hookin[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>hash</th>
          <th>address</th>
          <th>amount</th>
          <th>tx</th>
          <th>claim</th>
        </tr>
      </thead>
      <tbody>
        {hookins.map(hookin => (
          <Hookin key={hookin.hash} hookinDoc={hookin} />
        ))}
      </tbody>
    </table>
  );
}

function Hookin({ hookinDoc }: { hookinDoc: Docs.Hookin }) {
  const spentStatus = useClaimStatus(hookinDoc.hash);

  function renderSpentStatus() {
    if (spentStatus === 'LOADING') {
      return <span>loading...</span>;
    } else if (spentStatus === 'UNCOLLECTED') {
      return <button onClick={() => wallet.claimHookin(hookinDoc)}>Collect</button>;
    } else {
      return (
        <span>
          Claimed by <code>{spentStatus.claimRequest.claim.substring(0, 8)}...</code>
        </span>
      );
    }
  }

  return (
    <tr>
      <td>
        <Link to={`/hookins/${hookinDoc.hash}`}>{hookinDoc.hash.substring(0, 8)}...</Link>
      </td>
      <td>
        <Link to={`/addresses/bitcoin/${hookinDoc.bitcoinAddress}`}>{hookinDoc.bitcoinAddress.substring(0, 8)}...</Link>
      </td>
      <td>{hookinDoc.amount} sat</td>
      <td>
        <Link to={`https://blockstream.info/testnet/tx/${hookinDoc.txid}?input:${hookinDoc.vout}`}>{hookinDoc.txid.substring(0, 8)}...</Link>
      </td>
      <td>{renderSpentStatus()}</td>
    </tr>
  );
}