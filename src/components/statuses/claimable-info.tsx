import React from 'react';
import { RouteComponentProps } from 'react-router';
import LightningInvoice from './lightning-invoice-statuses';
import LightningPayment from './lightning-payment-statuses';
import DevDataDisplay from './dev-data-display';

import * as hi from 'moneypot-lib';

import { wallet, useClaimable, useClaimableStatuses } from '../../state/wallet';
import { notError } from '../../util';
import HookinStatuses from './hookin-statuses';
import HookoutStatuses from './hookout-statuses';
import FeeBumpStatuses from './feebump-statuses';
import { Button } from 'reactstrap';

export default function ClaimableInfo(props: RouteComponentProps<{ hash: string }>) {
  const hash = props.match.params.hash;

  const claimableDoc = useClaimable(hash);

  if (claimableDoc === 'LOADING') {
    return <div>{claimableDoc}</div>;
  }
  if (claimableDoc === undefined) {
    return <div>not found</div>;
  }

  let claimable: hi.Claimable | hi.Acknowledged.Claimable;
  if (claimableDoc.acknowledgement) {
    claimable = notError(hi.Acknowledged.claimableFromPOD(claimableDoc));
  } else {
    claimable = notError(hi.claimableFromPOD(claimableDoc));
  }

  let ackStatus = () => {
    if (claimable instanceof hi.Acknowledged.default) {
      return (
        <span>
          Acknowledged: <code>{claimable.acknowledgement.toPOD()}</code>
        </span>
      );
    }

    let x: hi.Claimable = claimable;

    return (
      <button
        onClick={() => {
          wallet.acknowledgeClaimable(x);
        }}
      >
        Claim
      </button>
    );
  };

  let kindOfClaimable = () => {
    switch (claimableDoc.kind) {
      case 'LightningInvoice':
        return (
          claimable instanceof hi.Acknowledged.default && (
            <LightningInvoice
              paymentRequest={claimableDoc.paymentRequest}
              created={claimableDoc.created}
              claimableHash={claimableDoc.hash}
              claimable={claimable}
            />
          )
        );
      case 'LightningPayment':
        return (
          claimable instanceof hi.Acknowledged.default && (
            <LightningPayment
              paymentRequest={claimableDoc.paymentRequest}
              created={claimableDoc.created}
              memo=""
              claimableHash={claimableDoc.hash}
              claimable={claimable as hi.LightningPayment & Partial<hi.Acknowledged.Claimable>}
            />
          )
        );
      case 'Hookin':
        return (
          <HookinStatuses
            created={claimableDoc.created}
            claimableHash={claimableDoc.hash}
            claimable={claimable as hi.Hookin & Partial<hi.Acknowledged.Claimable>}
          />
        );
      case 'Hookout':
        return (
          <HookoutStatuses
            created={claimableDoc.created}
            claimableHash={claimableDoc.hash}
            claimable={claimable as hi.Hookout & Partial<hi.Acknowledged.Claimable>}
          />
        );
      case 'FeeBump':
        return (
          <FeeBumpStatuses
            created={claimableDoc.created}
            claimableHash={claimableDoc.hash}
            claimable={claimable as hi.FeeBump & Partial<hi.Acknowledged.Claimable>}
          />
        );
      default:
        return <span>Loading...</span>;
    }
  };

  return (
    <div>
      {kindOfClaimable()}
      {(!(claimable instanceof hi.Acknowledged.default)) ? // we can only remove unacked claimables. (TODO: if uncorrectly synced with custodian, this might cause confusion)
        <Button color="primary"
          onClick={() => {
            wallet.discardClaimable(claimableDoc.hash);
            props.history.push('/claimables');
          }}
        >
        </Button> : undefined
      }
      {<br />}
      {<br />}
      
      {claimable instanceof hi.Acknowledged.default && <ShowStatuses claimable={claimable} claimableHash={claimableDoc.hash} />}
      <DevDataDisplay title="Raw Claimable">{claimableDoc}</DevDataDisplay>
    </div>
  );
}

// TODO: I think showing this dev-data isn't such a bad idea.
function ShowStatuses({ claimable, claimableHash }: { claimable: hi.Acknowledged.Claimable; claimableHash: string }) {
  const statuses = useClaimableStatuses(claimableHash);
  if (!statuses) {
    return <span>Loading statuses...</span>;
  }
  const claimableAmount = hi.computeClaimableRemaining(claimable.contents, statuses);
  return (
    <div id="status">
      <h6>Statuses ({statuses.length})</h6>
      <ul>
        {statuses.map(s => {
          const obj = hi.statusToPOD(s);

          return (
            <DevDataDisplay title={'Status - ' + obj.kind} key={s.hash().toPOD()}>
              {obj}
            </DevDataDisplay>
          );
        })}
      </ul>
      <button className="btn btn-light" onClick={() => wallet.claimClaimable(claimable)}>
        Claim {claimableAmount} sats
      </button>{' '}
      <button className="btn btn-light" onClick={() => wallet.requestStatuses(claimableHash)}>
        Check for status updates
      </button>{' '}
    </div>
  );
}

