// api/diagnose-xero-verify.js
// Verification probe — does combined where filter work, what's in descriptor fields,
// and does (reconciled + net unreconciled) = Alex's actual cash?

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { xero_access_token, xero_tenant_id } = req.body;

  if (!xero_access_token || !xero_tenant_id) {
    return res.status(400).json({ error: "Missing tokens" });
  }

  const headers = {
    Authorization: `Bearer ${xero_access_token}`,
    "Xero-tenant-id": xero_tenant_id,
    Accept: "application/json",
  };

  const today = new Date().toISOString().split("T")[0];
  const results = { date: today, tests: [] };

  // Helper to parse Xero's /Date(timestamp+0000)/ format
  const parseXeroDate = (s) => {
    if (!s) return null;
    const m = s.match(/\/Date\((\d+)[+-]\d+\)\//);
    return m ? new Date(parseInt(m[1], 10)).toISOString().split("T")[0] : null;
  };

  // ─── TEST 1: Combined filter — IsReconciled=false AND Date >= recent ─────
  // Confirms we can filter to recent unreconciled data only
  try {
    const where = encodeURIComponent('IsReconciled==false AND Date>=DateTime(2026, 4, 1)');
    let allTxns = [];
    let page = 1;
    let keepGoing = true;

    while (keepGoing && page <= 10) {
      const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}&page=${page}`, { headers });
      if (!r.ok) {
        results.tests.push({
          name: "Test 1: Combined filter (recent unreconciled)",
          status: r.status,
          error: await r.text(),
        });
        break;
      }
      const data = await r.json();
      const batch = data?.BankTransactions || [];
      allTxns = allTxns.concat(batch);
      if (batch.length < 100) keepGoing = false;
      else page += 1;
    }

    // Aggregate
    const byBankAccount = {};
    let totalReceive = 0, totalSpend = 0;
    const sampleDescriptors = [];

    for (const t of allTxns) {
      const acct = t.BankAccount?.Name || "Unknown";
      if (!byBankAccount[acct]) byBankAccount[acct] = { receive: 0, spend: 0, count: 0 };

      const total = parseFloat(t.Total || 0);
      if (t.Type === "RECEIVE" || t.Type === "RECEIVE-TRANSFER") {
        byBankAccount[acct].receive += total;
        totalReceive += total;
      } else if (t.Type === "SPEND" || t.Type === "SPEND-TRANSFER") {
        byBankAccount[acct].spend += total;
        totalSpend += total;
      }
      byBankAccount[acct].count += 1;

      // Capture sample descriptors from various possible fields to see where bank feed text lives
      if (sampleDescriptors.length < 15) {
        sampleDescriptors.push({
          Date: parseXeroDate(t.Date),
          Type: t.Type,
          Total: total,
          Reference: t.Reference || "",
          // Other fields that might contain bank feed descriptor text
          Particulars: t.Particulars || "",
          Narration: t.Narration || "",
          BankTransactionID: t.BankTransactionID || null,
          Contact_Name: t.Contact?.Name || "",
          LineItems_first_Description: t.LineItems?.[0]?.Description || "",
          // All top-level keys so we can see what's actually on the object
          allTopLevelKeys: Object.keys(t),
        });
      }
    }

    results.tests.push({
      name: "Test 1: Combined filter — IsReconciled=false AND Date>=2026-04-01",
      status: 200,
      totalCount: allTxns.length,
      pagesFetched: page,
      totalReceiveSinceApr1: totalReceive.toFixed(2),
      totalSpendSinceApr1: totalSpend.toFixed(2),
      netCashFlowFromUnreconciled: (totalReceive - totalSpend).toFixed(2),
      byBankAccount,
      sampleDescriptors,
    });
  } catch (err) {
    results.tests.push({ name: "Test 1", error: err.message });
  }

  // ─── TEST 2: ALL unreconciled (no date filter) — for the true-cash math ──
  // This is what would add to the BalanceSheet figure to give live cash
  try {
    const where = encodeURIComponent('IsReconciled==false');
    let allTxns = [];
    let page = 1;
    let keepGoing = true;

    while (keepGoing && page <= 50) {  // hard cap to avoid runaway
      const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}&page=${page}`, { headers });
      if (!r.ok) break;
      const data = await r.json();
      const batch = data?.BankTransactions || [];
      allTxns = allTxns.concat(batch);
      if (batch.length < 100) keepGoing = false;
      else page += 1;
    }

    const byBankAccount = {};
    for (const t of allTxns) {
      const acct = t.BankAccount?.Name || "Unknown";
      if (!byBankAccount[acct]) byBankAccount[acct] = { receive: 0, spend: 0, count: 0, oldest: null, newest: null };
      const total = parseFloat(t.Total || 0);
      const dateStr = parseXeroDate(t.Date);

      if (t.Type === "RECEIVE" || t.Type === "RECEIVE-TRANSFER") {
        byBankAccount[acct].receive += total;
      } else if (t.Type === "SPEND" || t.Type === "SPEND-TRANSFER") {
        byBankAccount[acct].spend += total;
      }
      byBankAccount[acct].count += 1;
      if (dateStr) {
        if (!byBankAccount[acct].oldest || dateStr < byBankAccount[acct].oldest) byBankAccount[acct].oldest = dateStr;
        if (!byBankAccount[acct].newest || dateStr > byBankAccount[acct].newest) byBankAccount[acct].newest = dateStr;
      }
    }

    // Calculate net unreconciled per account
    for (const k in byBankAccount) {
      byBankAccount[k].net = (byBankAccount[k].receive - byBankAccount[k].spend).toFixed(2);
      byBankAccount[k].receive = byBankAccount[k].receive.toFixed(2);
      byBankAccount[k].spend = byBankAccount[k].spend.toFixed(2);
    }

    results.tests.push({
      name: "Test 2: ALL unreconciled (full history)",
      totalCount: allTxns.length,
      pagesFetched: page,
      byBankAccount,
      hitPageCap: page > 50,
    });
  } catch (err) {
    results.tests.push({ name: "Test 2", error: err.message });
  }

  // ─── TEST 3: Get the BalanceSheet number for math comparison ─────────────
  try {
    const r = await fetch(`https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${today}`, { headers });
    const data = await r.json();
    const report = data?.Reports?.[0];

    const accounts = {};
    const searchRows = (rows) => {
      for (const row of rows || []) {
        if (row.RowType === "Row" || row.RowType === "SummaryRow") {
          const label = row.Cells?.[0]?.Value || "";
          const val = parseFloat((row.Cells?.[1]?.Value || "").replace(/,/g, ""));
          if (!isNaN(val) && (label.toLowerCase().includes("bank") || label.toLowerCase().includes("account") || label.toLowerCase().includes("paypal") || label.toLowerCase().includes("business") || label.toLowerCase().includes("direct debit"))) {
            accounts[label] = val;
          }
        }
        if (row.Rows) searchRows(row.Rows);
      }
    };
    searchRows(report.Rows);

    results.tests.push({
      name: "Test 3: BalanceSheet reconciled bank balances",
      bankAccountsFromBalanceSheet: accounts,
    });
  } catch (err) {
    results.tests.push({ name: "Test 3", error: err.message });
  }

  return res.status(200).json(results);
}
