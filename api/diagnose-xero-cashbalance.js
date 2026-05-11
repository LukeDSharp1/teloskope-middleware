// api/diagnose-xero-cashbalance.js
// Tests BankSummary and Accounts endpoints to find which returns LIVE bank balance
// (not the reconciliation-shackled BalanceSheet figure)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { xero_access_token, xero_tenant_id } = req.body;

  if (!xero_access_token || !xero_tenant_id) {
    return res.status(400).json({ error: "Missing xero_access_token or xero_tenant_id" });
  }

  // ─── DATE: prior Sunday at 23:59 ─────────────────────────────────────────
  // We want the most recent Sunday that has already passed in AEST.
  const now = new Date();
  const aestOffset = 10 * 60 * 60 * 1000;
  const nowAest = new Date(now.getTime() + aestOffset);
  const dayOfWeek = nowAest.getUTCDay(); // 0 = Sunday
  const daysBackToSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
  const priorSunday = new Date(nowAest);
  priorSunday.setUTCDate(priorSunday.getUTCDate() - daysBackToSunday);
  const priorSundayDate = priorSunday.toISOString().split("T")[0];

  const results = {
    targetDate: priorSundayDate,
    tests: [],
  };

  // ─── TEST 1: List bank accounts (need account IDs for some calls) ────────
  let bankAccounts = [];
  try {
    const r = await fetch("https://api.xero.com/api.xro/2.0/Accounts?where=Type==%22BANK%22", {
      headers: {
        Authorization: `Bearer ${xero_access_token}`,
        "Xero-tenant-id": xero_tenant_id,
        Accept: "application/json",
      },
    });
    const data = await r.json();
    bankAccounts = (data?.Accounts || []).filter(a => a.Status === "ACTIVE").map(a => ({
      id: a.AccountID,
      name: a.Name,
      code: a.Code,
      type: a.Type,
      bankAccountNumber: a.BankAccountNumber,
      // The Accounts endpoint also returns a balance — capture it for comparison
      balanceFromAccountsEndpoint: a.Balance ?? null,
    }));
    results.tests.push({
      name: "Test 1: List bank accounts",
      status: r.status,
      bankAccounts,
    });
  } catch (err) {
    results.tests.push({ name: "Test 1", error: err.message });
  }

  // ─── TEST 2: Reports/BankSummary as at prior Sunday ──────────────────────
  try {
    const url = `https://api.xero.com/api.xro/2.0/Reports/BankSummary?fromDate=${priorSundayDate}&toDate=${priorSundayDate}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${xero_access_token}`,
        "Xero-tenant-id": xero_tenant_id,
        Accept: "application/json",
      },
    });
    const body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = { rawText: body.substring(0, 500) }; }

    const report = parsed?.Reports?.[0];

    // Extract closing balance per account from the report rows
    const accountSummaries = [];
    let totalClosingBalance = 0;

    if (r.ok && report) {
      // Find header row to map columns
      let columnMap = {};
      const findHeaders = (rows) => {
        for (const row of rows || []) {
          if (row.RowType === "Header" && row.Cells) {
            row.Cells.forEach((cell, i) => {
              const label = (cell.Value || "").toLowerCase().trim();
              if (label) columnMap[label] = i;
            });
            return;
          }
          if (row.Rows) findHeaders(row.Rows);
        }
      };
      findHeaders(report.Rows);

      const closingIdx = columnMap["closing balance"] ?? columnMap["balance"];
      const openingIdx = columnMap["opening balance"];
      const cashInIdx  = columnMap["cash received"] ?? columnMap["cash in"];
      const cashOutIdx = columnMap["cash spent"] ?? columnMap["cash out"];

      const extractRows = (rowList) => {
        for (const row of rowList || []) {
          if (row.RowType === "Row" && row.Cells) {
            const accountName = row.Cells[0]?.Value || "";
            const opening = parseFloat((row.Cells[openingIdx]?.Value || "").replace(/,/g, "")) || 0;
            const cashIn  = parseFloat((row.Cells[cashInIdx]?.Value || "").replace(/,/g, "")) || 0;
            const cashOut = parseFloat((row.Cells[cashOutIdx]?.Value || "").replace(/,/g, "")) || 0;
            const closing = parseFloat((row.Cells[closingIdx]?.Value || "").replace(/,/g, "")) || 0;
            if (accountName && (opening !== 0 || closing !== 0)) {
              accountSummaries.push({ accountName, opening, cashIn, cashOut, closing });
              totalClosingBalance += closing;
            }
          }
          if (row.Rows) extractRows(row.Rows);
        }
      };
      extractRows(report.Rows);
    }

    results.tests.push({
      name: "Test 2: Reports/BankSummary at prior Sunday",
      endpoint: `Reports/BankSummary?fromDate=${priorSundayDate}&toDate=${priorSundayDate}`,
      status: r.status,
      ok: r.ok,
      columnMap: Object.keys(columnMap || {}),
      accountSummaries,
      totalClosingBalance: totalClosingBalance.toFixed(2),
      errorBody: !r.ok ? parsed : null,
    });
  } catch (err) {
    results.tests.push({ name: "Test 2", error: err.message });
  }

  // ─── TEST 3: BalanceSheet at prior Sunday (baseline comparison) ──────────
  try {
    const url = `https://api.xero.com/api.xro/2.0/Reports/BalanceSheet?date=${priorSundayDate}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${xero_access_token}`,
        "Xero-tenant-id": xero_tenant_id,
        Accept: "application/json",
      },
    });
    const body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = { rawText: body.substring(0, 500) }; }

    let totalBank = null;
    if (r.ok) {
      const report = parsed?.Reports?.[0];
      const searchRows = (rows) => {
        for (const row of rows || []) {
          if (row.RowType === "Row" || row.RowType === "SummaryRow") {
            const label = (row.Cells?.[0]?.Value || "").toLowerCase();
            const val = parseFloat((row.Cells?.[1]?.Value || "").replace(/,/g, ""));
            if (!isNaN(val) && label.includes("total bank")) {
              totalBank = val;
            }
          }
          if (row.Rows) searchRows(row.Rows);
        }
      };
      searchRows(report?.Rows);
    }

    results.tests.push({
      name: "Test 3: BalanceSheet at prior Sunday (baseline)",
      endpoint: `Reports/BalanceSheet?date=${priorSundayDate}`,
      status: r.status,
      ok: r.ok,
      totalBankFromBalanceSheet: totalBank,
      errorBody: !r.ok ? parsed : null,
    });
  } catch (err) {
    results.tests.push({ name: "Test 3", error: err.message });
  }

  // ─── TEST 4: Individual Accounts/{id} for each bank account ──────────────
  // Some Xero setups return live balance via this endpoint
  if (bankAccounts.length > 0) {
    const individualAccounts = [];
    for (const acct of bankAccounts) {
      try {
        const r = await fetch(`https://api.xero.com/api.xro/2.0/Accounts/${acct.id}`, {
          headers: {
            Authorization: `Bearer ${xero_access_token}`,
            "Xero-tenant-id": xero_tenant_id,
            Accept: "application/json",
          },
        });
        const data = await r.json();
        const acctData = data?.Accounts?.[0];
        individualAccounts.push({
          name: acct.name,
          id: acct.id,
          status: r.status,
          balanceFields: {
            // Different Xero responses have balance in different places
            Balance: acctData?.Balance ?? null,
            CurrentBalance: acctData?.CurrentBalance ?? null,
            BankFeed: acctData?.BankFeed ?? null,
          },
        });
      } catch (err) {
        individualAccounts.push({ name: acct.name, error: err.message });
      }
    }
    results.tests.push({
      name: "Test 4: Individual Accounts/{id} per bank account",
      individualAccounts,
    });
  }

  return res.status(200).json(results);
}
