export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { xero_access_token, xero_tenant_id } = req.body;

  if (!xero_access_token || !xero_tenant_id) {
    return res.status(400).json({
      error: "Missing xero_access_token or xero_tenant_id"
    });
  }

  const headers = {
    Authorization: `Bearer ${xero_access_token}`,
    "Xero-tenant-id": xero_tenant_id,
    Accept: "application/json"
  };

  const results = {
    bank_accounts: [],
    xero_cash_balance: 0,
    unreconciled_transactions: [],
    unreconciled_adjustment: 0,
    estimated_cash_position: 0,
    notes: []
  };

  try {
    // 1. Get bank accounts
    const accountsUrl =
      'https://api.xero.com/api.xro/2.0/Accounts?where=Type=="BANK"';

    const accountsRes = await fetch(accountsUrl, { headers });
    const accountsText = await accountsRes.text();

    let accountsData;
    try {
      accountsData = JSON.parse(accountsText);
    } catch {
      return res.status(500).json({
        error: "Could not parse Accounts response",
        raw: accountsText
      });
    }

    if (!accountsRes.ok) {
      return res.status(accountsRes.status).json({
        error: "Xero Accounts call failed",
        status: accountsRes.status,
        body: accountsData
      });
    }

    const bankAccounts = accountsData.Accounts || [];

    results.bank_accounts = bankAccounts.map((a) => ({
      account_id: a.AccountID,
      name: a.Name,
      code: a.Code,
      balance: Number(a.Balance || 0)
    }));

    results.xero_cash_balance = results.bank_accounts.reduce(
      (sum, a) => sum + a.balance,
      0
    );

    // 2. Get unreconciled BankTransactions
    const bankTxUrl =
      "https://api.xero.com/api.xro/2.0/BankTransactions?where=" +
      encodeURIComponent("IsReconciled==false");

    const txRes = await fetch(bankTxUrl, { headers });
    const txText = await txRes.text();

    let txData;
    try {
      txData = JSON.parse(txText);
    } catch {
      return res.status(500).json({
        error: "Could not parse BankTransactions response",
        raw: txText
      });
    }

    if (!txRes.ok) {
      return res.status(txRes.status).json({
        error: "Xero BankTransactions call failed",
        status: txRes.status,
        body: txData
      });
    }

    const transactions = txData.BankTransactions || [];

    results.unreconciled_transactions = transactions.map((tx) => ({
      id: tx.BankTransactionID,
      date: tx.DateString || tx.Date,
      type: tx.Type,
      status: tx.Status,
      contact: tx.Contact?.Name || null,
      total: Number(tx.Total || 0),
      is_reconciled: tx.IsReconciled,
      bank_account: tx.BankAccount?.Name || null
    }));

    for (const tx of transactions) {
      const amount = Number(tx.Total || 0);

      if (tx.Type === "RECEIVE") {
        results.unreconciled_adjustment += amount;
      } else if (tx.Type === "SPEND") {
        results.unreconciled_adjustment -= amount;
      }
    }

    results.estimated_cash_position =
      results.xero_cash_balance + results.unreconciled_adjustment;

    results.notes.push(
      "This is an estimate only. It uses Xero bank account balances plus unreconciled BankTransactions, not raw live bank feed balances."
    );

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({
      error: "Unexpected server error",
      message: err.message
    });
  }
}
