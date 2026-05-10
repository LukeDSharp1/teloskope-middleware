// api/diagnose-xero-bankstatement.js
// One-off diagnostic to test what Reports/BankStatement returns with current OAuth scopes.
// Call via POST with the same Xero token params as generate-weekly-brief.
// Returns full response body so we can see exactly what Xero says.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const {
    xero_access_token,
    xero_tenant_id,
  } = req.body;

  if (!xero_access_token || !xero_tenant_id) {
    return res.status(400).json({ error: "Missing xero_access_token or xero_tenant_id" });
  }

  const results = {
    tests: [],
  };

  // ─── TEST 1: List bank accounts ──────────────────────────────────────────
  try {
    const r1 = await fetch("https://api.xero.com/api.xro/2.0/Accounts?where=Type==%22BANK%22", {
      headers: {
        Authorization: `Bearer ${xero_access_token}`,
        "Xero-tenant-id": xero_tenant_id,
        Accept: "application/json",
      },
    });
    const body1 = await r1.text();
    let parsed1;
    try { parsed1 = JSON.parse(body1); } catch { parsed1 = { rawText: body1.substring(0, 500) }; }

    results.tests.push({
      name: "Test 1: List bank accounts",
      endpoint: "Accounts?where=Type==BANK",
      status: r1.status,
      ok: r1.ok,
      headers: {
        wwwAuthenticate: r1.headers.get("WWW-Authenticate"),
      },
      bankAccountIds: r1.ok ? (parsed1?.Accounts || []).map(a => ({ id: a.AccountID, name: a.Name })) : null,
      errorBody: !r1.ok ? parsed1 : null,
    });
  } catch (err) {
    results.tests.push({ name: "Test 1: List bank accounts", error: err.message });
  }

  // ─── TEST 2: Reports/BankStatement WITHOUT a bank account ID ────────────
  // Some Xero docs suggest you can call without account ID and get all
  try {
    const fromDate = "2026-04-01";
    const toDate   = "2026-05-07";
    const url2 = `https://api.xero.com/api.xro/2.0/Reports/BankStatement?fromDate=${fromDate}&toDate=${toDate}`;

    const r2 = await fetch(url2, {
      headers: {
        Authorization: `Bearer ${xero_access_token}`,
        "Xero-tenant-id": xero_tenant_id,
        Accept: "application/json",
      },
    });
    const body2 = await r2.text();
    let parsed2;
    try { parsed2 = JSON.parse(body2); } catch { parsed2 = { rawText: body2.substring(0, 500) }; }

    results.tests.push({
      name: "Test 2: Reports/BankStatement (no account ID)",
      endpoint: "Reports/BankStatement",
      status: r2.status,
      ok: r2.ok,
      headers: {
        wwwAuthenticate: r2.headers.get("WWW-Authenticate"),
      },
      hasReports: r2.ok && Array.isArray(parsed2?.Reports),
      reportName: r2.ok ? parsed2?.Reports?.[0]?.ReportName : null,
      rowCount: r2.ok ? (parsed2?.Reports?.[0]?.Rows?.length || 0) : null,
      // First section's row count, if it's a Section row
      sampleRowTypes: r2.ok ? (parsed2?.Reports?.[0]?.Rows || []).map(r => ({
        type: r.RowType,
        title: r.Title || null,
        cellCount: r.Cells?.length || 0,
        nestedRowCount: r.Rows?.length || 0,
      })) : null,
      errorBody: !r2.ok ? parsed2 : null,
    });
  } catch (err) {
    results.tests.push({ name: "Test 2", error: err.message });
  }

  // ─── TEST 3: Reports/BankStatement WITH a bank account ID ───────────────
  // This is the actual usage pattern
  try {
    // Get the first bank account ID from Test 1
    const firstAccountId = results.tests[0]?.bankAccountIds?.[0]?.id;
    if (!firstAccountId) {
      results.tests.push({ name: "Test 3", skipped: "No bank account ID from Test 1" });
    } else {
      const fromDate = "2026-04-01";
      const toDate   = "2026-05-07";
      const url3 = `https://api.xero.com/api.xro/2.0/Reports/BankStatement?bankAccountID=${firstAccountId}&fromDate=${fromDate}&toDate=${toDate}`;

      const r3 = await fetch(url3, {
        headers: {
          Authorization: `Bearer ${xero_access_token}`,
          "Xero-tenant-id": xero_tenant_id,
          Accept: "application/json",
        },
      });
      const body3 = await r3.text();
      let parsed3;
      try { parsed3 = JSON.parse(body3); } catch { parsed3 = { rawText: body3.substring(0, 500) }; }

      // Count actual transaction rows (RowType: "Row" inside Sections)
      let rowCount = 0;
      const countRows = (rows) => {
        for (const row of rows || []) {
          if (row.RowType === "Row") rowCount += 1;
          if (row.Rows) countRows(row.Rows);
        }
      };
      if (r3.ok) countRows(parsed3?.Reports?.[0]?.Rows);

      results.tests.push({
        name: "Test 3: Reports/BankStatement (with account ID)",
        endpoint: `Reports/BankStatement?bankAccountID=${firstAccountId}`,
        status: r3.status,
        ok: r3.ok,
        headers: {
          wwwAuthenticate: r3.headers.get("WWW-Authenticate"),
        },
        hasReports: r3.ok && Array.isArray(parsed3?.Reports),
        reportName: r3.ok ? parsed3?.Reports?.[0]?.ReportName : null,
        transactionRowCount: r3.ok ? rowCount : null,
        // Sample first 3 rows if present
        sampleFirstRows: r3.ok ? extractSampleRows(parsed3?.Reports?.[0]?.Rows, 3) : null,
        errorBody: !r3.ok ? parsed3 : null,
      });
    }
  } catch (err) {
    results.tests.push({ name: "Test 3", error: err.message });
  }

  // ─── TEST 4: BankTransactions endpoint (for comparison) ─────────────────
  try {
    const where = encodeURIComponent("Date >= DateTime(2026, 4, 1) AND Date <= DateTime(2026, 5, 7)");
    const r4 = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}`, {
      headers: {
        Authorization: `Bearer ${xero_access_token}`,
        "Xero-tenant-id": xero_tenant_id,
        Accept: "application/json",
      },
    });
    const body4 = await r4.text();
    let parsed4;
    try { parsed4 = JSON.parse(body4); } catch { parsed4 = { rawText: body4.substring(0, 500) }; }

    results.tests.push({
      name: "Test 4: BankTransactions (existing endpoint, for comparison)",
      endpoint: "BankTransactions",
      status: r4.status,
      ok: r4.ok,
      transactionCount: r4.ok ? (parsed4?.BankTransactions?.length || 0) : null,
      errorBody: !r4.ok ? parsed4 : null,
    });
  } catch (err) {
    results.tests.push({ name: "Test 4", error: err.message });
  }

  return res.status(200).json(results);
}

function extractSampleRows(rows, max) {
  const samples = [];
  const collect = (rowList) => {
    for (const row of rowList || []) {
      if (samples.length >= max) return;
      if (row.RowType === "Row" && row.Cells) {
        samples.push({
          rowType: row.RowType,
          cells: row.Cells.map(c => c.Value),
        });
      }
      if (row.RowType === "Header" && row.Cells) {
        samples.push({
          rowType: row.RowType,
          cells: row.Cells.map(c => c.Value),
        });
      }
      if (row.Rows && samples.length < max) collect(row.Rows);
    }
  };
  collect(rows);
  return samples;
}
