// api/diagnose-xero-final.js
// Final probe — Bank Reconciliation Summary + full Account object fields

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

  // ─── TEST 1: Bank Reconciliation Summary Report ──────────────────────────
  // This report in Xero UI shows reconciled balance + outstanding (unreconciled) items
  // If accessible via API, it would give us the gap we need
  for (const reportName of [
    "BankReconciliationSummary",
    "BankReconciliation",
    "ReconciliationSummary",
    "BankReconciliationReport",
  ]) {
    try {
      const r = await fetch(`https://api.xero.com/api.xro/2.0/Reports/${reportName}?date=${today}`, { headers });
      const body = await r.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { rawText: body.substring(0, 300) }; }
      results.tests.push({
        name: `Test 1: Reports/${reportName}`,
        status: r.status,
        ok: r.ok,
        reportTitles: r.ok ? parsed?.Reports?.[0]?.ReportTitles : null,
        firstFewRows: r.ok ? extractSampleCells(parsed?.Reports?.[0]?.Rows, 10) : null,
        errorBody: !r.ok ? parsed : null,
      });
    } catch (err) {
      results.tests.push({ name: `Test 1: ${reportName}`, error: err.message });
    }
  }

  // ─── TEST 2: Full Account object — every field for the Business Account ──
  // Business account ID from prior diagnostic
  const businessAccountId = "eec1355f-58b7-4636-b8eb-9dac435b057c";
  try {
    const r = await fetch(`https://api.xero.com/api.xro/2.0/Accounts/${businessAccountId}`, { headers });
    const data = await r.json();
    results.tests.push({
      name: "Test 2: Full Account object",
      status: r.status,
      fullAccountObject: data?.Accounts?.[0] || data,
    });
  } catch (err) {
    results.tests.push({ name: "Test 2", error: err.message });
  }

  // ─── TEST 3: BankTransactions with no filter (just see what comes back) ──
  // The where filter might be excluding statement lines — try without
  try {
    const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?page=1`, { headers });
    const data = await r.json();
    const txns = data?.BankTransactions || [];
    results.tests.push({
      name: "Test 3: BankTransactions (no filter, just page 1)",
      status: r.status,
      totalReturned: txns.length,
      firstFew: txns.slice(0, 5).map(t => ({
        Date: t.Date,
        Type: t.Type,
        Total: t.Total,
        Status: t.Status,
        IsReconciled: t.IsReconciled,
        BankAccount: t.BankAccount?.Name,
        Contact: t.Contact?.Name,
        Reference: t.Reference,
      })),
      uniqueStatuses: [...new Set(txns.map(t => t.Status))],
      uniqueReconciledValues: [...new Set(txns.map(t => t.IsReconciled))],
    });
  } catch (err) {
    results.tests.push({ name: "Test 3", error: err.message });
  }

  // ─── TEST 4: Try filtering for IsReconciled=false ────────────────────────
  // If this returns anything, that's our endpoint
  try {
    const where = encodeURIComponent("IsReconciled==false");
    const r = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}&page=1`, { headers });
    const data = await r.json();
    const txns = data?.BankTransactions || [];
    results.tests.push({
      name: "Test 4: BankTransactions filtered IsReconciled=false",
      status: r.status,
      totalReturned: txns.length,
      sampleTxns: txns.slice(0, 5).map(t => ({
        Date: t.Date,
        Type: t.Type,
        Total: t.Total,
        IsReconciled: t.IsReconciled,
        BankAccount: t.BankAccount?.Name,
        Reference: t.Reference,
      })),
    });
  } catch (err) {
    results.tests.push({ name: "Test 4", error: err.message });
  }

  // ─── TEST 5: Reports/ProfitAndLoss as a fallback sanity check ────────────
  // Confirms what's "really there" for the org according to reconciled data
  try {
    const r = await fetch(`https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=2026-04-01&toDate=${today}`, { headers });
    const data = await r.json();
    results.tests.push({
      name: "Test 5: ProfitAndLoss (sanity check)",
      status: r.status,
      reportTitles: data?.Reports?.[0]?.ReportTitles,
    });
  } catch (err) {
    results.tests.push({ name: "Test 5", error: err.message });
  }

  return res.status(200).json(results);
}

function extractSampleCells(rows, max) {
  const samples = [];
  const collect = (rowList) => {
    for (const row of rowList || []) {
      if (samples.length >= max) return;
      if (row.RowType && row.Cells) {
        samples.push({
          type: row.RowType,
          title: row.Title || null,
          cells: row.Cells.map(c => c.Value),
        });
      }
      if (row.Rows) collect(row.Rows);
    }
  };
  collect(rows);
  return samples;
}
