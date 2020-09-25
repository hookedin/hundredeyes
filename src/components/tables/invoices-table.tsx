import React from 'react';
import { Link } from 'react-router-dom';
import * as hi from 'moneypot-lib';

import { useClaimableStatuses } from '../../state/wallet';

import * as Docs from '../../wallet/docs';
import { notError } from '../../util';
import InvoiceSettledStatus from 'moneypot-lib/dist/status/invoice-settled';

export default function InvoicesTable({ invoices }: { invoices: (Docs.Claimable & hi.POD.LightningInvoice)[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>hash</th>
          <th>invoice</th>
          <th>amount</th>
          <th>expired</th>
          <th>paid</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map(invoice => (
          <Invoice key={invoice.hash} invoiceDoc={invoice} />
        ))}
      </tbody>
    </table>
  );
}

function Invoice({ invoiceDoc }: { invoiceDoc: Docs.Claimable & hi.POD.LightningInvoice }) {
  const pro = notError(hi.decodeBolt11(invoiceDoc.paymentRequest));
  function renderPaymentStatus() {
    const statuses = useClaimableStatuses(invoiceDoc.hash);
    if (statuses) {
      if (statuses.length > 1) {
        for (const s of statuses) {
          if (s instanceof InvoiceSettledStatus) {
            return 'true';
          }
        }
      }
    }
    return 'false';
  }

  function isExpired() {
    const pro = notError(hi.decodeBolt11(invoiceDoc.paymentRequest));
    const currentTime = new Date().getTime();
    const expiryTime = new Date(pro.timeExpireDateString).getTime();
    if (currentTime > expiryTime) {
      return 'Invoice has expired';
    } else if (currentTime < expiryTime) {
      return 'Invoice is stil valid';
    }
    return '???';
  }

  return (
    <tr>
      <td>
        <Link to={`/claimables/${invoiceDoc.hash}`}>{invoiceDoc.hash.substring(0, 32)}...</Link>
      </td>
      <td>
        <Link to={`/claimables/${invoiceDoc.hash}`}>{invoiceDoc.paymentRequest.substring(0, 32)}...</Link>
      </td>
      <td>{pro.satoshis} sat</td>
      <td>{isExpired()}</td>

      <td>{renderPaymentStatus()}</td>
    </tr>
  );
}
