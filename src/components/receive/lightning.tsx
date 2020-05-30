import React, { useState, useEffect } from 'react';
import { RouteComponentProps } from 'react-router';

import { wallet } from '../../state/wallet';
import { Button, Col, Form, FormGroup, Input, InputGroup, Label } from 'reactstrap';
import BitcoinAmountInput from '../bitcoin-amount-input';


export interface capacities {
  localbalance: number;
  remotebalance: number;
  capacity: number;
}

export default function ReceiveLightning(props: RouteComponentProps) {
  const [memo, setMemo] = useState('deposit');
  const [amount, setAmount] = useState(0);
  const [lndcapacities, setlndcapacities] = useState<capacities>(Object);
  useEffect(() => {
    const getCapabilities = async () => {
   
      wallet.requestLightningCapacities().then((data) => { 
        setlndcapacities(data)
      })
    };
    getCapabilities();
  }, []);

  async function genInvoice() {
    const amountInt = amount;
    if(amount)
    if (!Number.isFinite(amountInt) || amountInt < 0) {
      console.warn('amount must be an integer >= 0');
      return;
    }
    // if(amount > lndcapacities.remotebalance) {
    //   throw "invoice too large"
    // }
  

    const res = await wallet.requestLightningInvoice(memo, amountInt);

    props.history.push(`/claimables/${res.hash}`, res);
  }
  function isPossible() {
    if(amount > lndcapacities.remotebalance) { 
      return "Our node does not have enough capacity to handle such an invoice, so you can only use this invoice for internal transfers."
    } 
  }

  return (
    <div>
      <h5 className="main-header">Receive</h5>
      <div className="inner-container">
        <Form>
          <h6 style={{ marginBottom: '2rem' }}>Generate Lightning Invoice</h6>
          <FormGroup row>
            <Label for="memo" sm={3}>
              Memo:
            </Label>
            <Col sm={{ size: 9, offset: 0 }}>
              <InputGroup>
                <Input value={memo} onChange={e => setMemo(e.target.value)} type="text" className="to-text-input" />
              </InputGroup>
            </Col>
          </FormGroup>
          <FormGroup row>
            <Label for="amount" sm={3}>
              Amount:
            </Label>
            <Col sm={{ size: 9, offset: 0 }}>
              <InputGroup>
                <BitcoinAmountInput onAmountChange={setAmount} />
              </InputGroup>
            </Col>
          </FormGroup>
          <p>
           {isPossible()}
          </p>
          <FormGroup row>
            <Col className="submit-button-container">
              <Button color="success" className="btn-moneypot" onClick={() => genInvoice()}>
                Generate
              </Button>
            </Col>
          </FormGroup>
        </Form>
      </div>
    </div>
  );
}
