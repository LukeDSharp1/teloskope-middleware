export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { xero_access_token, xero_tenant_id, fromDate = "2026-05-01", toDate = "2026-05-11" } = req.body;

  if (!xero_access_token || !xero_tenant_id) {
    return res.status(400).json({ error: "Missing xero_access_token or xero_tenant_id" });
  }

  const headers = {
    Authorization: `Bearer ${xero_access_token}`,
    "Xero-tenant-id": xero_tenant_id,
    Accept: "application/json"
  };

  const toXeroDateTime = (dateStr) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return `DateTime(${y}, ${m}, ${d})`;
  };

  try {
    const accountsUrl = 'https://api.xero.com/api.xro/2.0/Accounts?where=Type=="BANK"';
    const accountsRes = await fetch(accountsUrl, { headers });
    const accountsData = await accountsRes.json();

    if (!accountsRes.ok) {
      return res.status(accountsRes.status).json({ error: "Accounts call failed", body: accountsData });
    }

    const bankAccounts = (accountsData.Accounts || []).map(a => ({
      account_id: a.AccountID,
      name: a.Name,
      code: a.Code,
      balance: Number(a.Balance || 0)
    }));

    const xeroCashBalance = bankAccounts.reduce((sum, a) => sum + a.balance, 0);

    const where = encodeURIComponent(
      `IsReconciled==false AND Status!="DELETED" AND Status!="VOIDED" AND Date >= ${toXeroDateTime(fromDate)} AND Date <= ${toXeroDateTime(toDate)}`
    );

    const txUrl = `https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}`;
    const txRes = await fetch(txUrl, { headers });
    const txData = await txRes.json();

    if (!txRes.ok) {
      return res.status(txRes.status).json({ error: "BankTransactions call failed", body: txData });
    }

    const transactions = txData.BankTransactions || [];

    const cleanTransactions = transactions.map(tx => ({
      id: tx.BankTransactionID,
      date: tx.DateString || tx.Date,
      type: tx.Type,
      status: tx.Status,
      contact: tx.Contact?.Name || null,
      total: Number(tx.Total || 0),
      is_reconciled: tx.IsReconciled,
      bank_account: tx.BankAccount?.Name || null
    }));

    let unreconciledAdjustment = 0;

    for (const tx of cleanTransactions) {
      if (tx.type === "RECEIVE") unreconciledAdjustment += tx.total;
      if (tx.type === "SPEND") unreconciledAdjustment -= tx.total;
    }

    return res.status(200).json({
      fromDate,
      toDate,
      bank_accounts: bankAccounts,
      xero_cash_balance: xeroCashBalance,
      unreconciled_transaction_count: cleanTransactions.length,
      unreconciled_transactions: cleanTransactions.slice(0, 20),
      unreconciled_adjustment: unreconciledAdjustment,
      estimated_cash_position: xeroCashBalance + unreconciledAdjustment,
      note: "Estimate only. Excludes deleted/voided items and only includes unreconciled BankTransactions in the selected date range."
    });
  } catch (err) {
    return res.status(500).json({ error: "Unexpected server error", message: err.message });
  }
}
