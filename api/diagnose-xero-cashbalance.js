// api/diagnose-xero-cashbalance.js
// v2 — fixed columnMap scope bug, tests BankSummary with multiple date strategies

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { xero_access_token, xero_tenant_id } = req.body;

  if (!xero_access_token || !xero_tenant_id) {
    return res.status(400).json({ error: "Missing xero_access_token or xero_tenant_id" });
  }

  const now = new Date();
  const aestOffset = 10 * 60 * 60 * 1000;
  const nowAest = new Date(now.getTime() + aestOffset);
  const dayOfWeek = nowAest.getUTCDay();
  const daysBackToSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
  const priorSunday = new Date(nowAest);
  priorSunday.setUTCDate(priorSunday.getUTCDate() - daysBackToSunday);
  const priorSundayDate = priorSunday.toISOString().split("T")[0];
  const today = nowAest.toISOString().split("T")[0];

  const results = {
    targetDate: priorSundayDate,
    todayDate: today,
    tests: [],
  };

  results.tests.push(await testBankSummary(xero_access_token, xero_tenant_id, priorSundayDate, priorSundayDate, "Test A: BankSummary at prior Sunday"));

  const priorMonday = new Date(priorSunday);
  priorMonday.setUTCDate(priorMonday.getUTCDate() - 6);
  const priorMondayDate = priorMonday.toISOString().split("T")[0];
  results.tests.push(await testBankSummary(xero_access_token, xero_tenant_id, priorMondayDate, priorSundayDate, "Test B: BankSummary for full prior week"));

  results.tests.push(await testBankSummary(xero_access_token, xero_tenant_id, today, today, "Test C: BankSummary as at today"));

  const thirtyDaysAgo = new Date(nowAest);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  const thirtyDaysAgoDate = thirtyDaysAgo.toISOString().split("T")[0];
  results.tests.push(await testBankSummary(xero_access_token, xero_tenant_id, thirtyDaysAgoDate, today, "Test D: BankSummary for last 30 days"));

  return res.status(200).json(results);
}


async function testBankSummary(token, tenantId, fromDate, toDate, testName) {
  try {
    const url = `https://api.xero.com/api.xro/2.0/Reports/BankSummary?fromDate=${fromDate}&toDate=${toDate}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    const body = await r.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = { rawText: body.substring(0, 500) }; }

    const result = {
      name: testName,
      endpoint: `Reports/BankSummary?fromDate=${fromDate}&toDate=${toDate}`,
      status: r.status,
      ok: r.ok,
    };

    if (!r.ok) {
      result.errorBody = parsed;
      return result;
    }

    const report = parsed?.Reports?.[0];
    if (!report) {
      result.error = "No report in response";
      return result;
    }

    const columnMap = {};
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

    result.columnsFound = Object.keys(columnMap);
    result.reportTitles = report.ReportTitles || [];

    const closingIdx = columnMap["closing balance"] ?? columnMap["balance"] ?? columnMap["closing"];
    const openingIdx = columnMap["opening balance"] ?? columnMap["opening"];
    const cashInIdx  = columnMap["cash received"] ?? columnMap["cash in"] ?? columnMap["received"];
    const cashOutIdx = columnMap["cash spent"] ?? columnMap["cash out"] ?? columnMap["spent"];

    result.columnIndices = { openingIdx, cashInIdx, cashOutIdx, closingIdx };

    const accountSummaries = [];
    let totalClosingBalance = 0;
    let totalCashIn = 0;
    let totalCashOut = 0;

    const extractRows = (rowList) => {
      for (const row of rowList || []) {
        if (row.RowType === "Row" && row.Cells) {
          const accountName = row.Cells[0]?.Value || "";
          const opening = parseFloat((row.Cells[openingIdx]?.Value || "").replace(/,/g, "")) || 0;
          const cashIn  = parseFloat((row.Cells[cashInIdx]?.Value || "").replace(/,/g, "")) || 0;
          const cashOut = parseFloat((row.Cells[cashOutIdx]?.Value || "").replace(/,/g, "")) || 0;
          const closing = parseFloat((row.Cells[closingIdx]?.Value || "").replace(/,/g, "")) || 0;
          if (accountName && (opening !== 0 || closing !== 0 || cashIn !== 0 || cashOut !== 0)) {
            accountSummaries.push({ accountName, opening, cashIn, cashOut, closing });
            totalClosingBalance += closing;
            totalCashIn += cashIn;
            totalCashOut += cashOut;
          }
        }
        if (row.Rows) extractRows(row.Rows);
      }
    };
    extractRows(report.Rows);

    result.accountSummaries = accountSummaries;
    result.totalClosingBalance = totalClosingBalance.toFixed(2);
    result.totalCashIn = totalCashIn.toFixed(2);
    result.totalCashOut = totalCashOut.toFixed(2);

    const sampleRawRows = [];
    const collectSamples = (rowList) => {
      for (const row of rowList || []) {
        if (sampleRawRows.length >= 6) return;
        if (row.RowType === "Row" || row.RowType === "Header" || row.RowType === "SummaryRow") {
          sampleRawRows.push({
            type: row.RowType,
            cells: row.Cells?.map(c => c.Value) || [],
          });
        }
        if (row.Rows) collectSamples(row.Rows);
      }
    };
    collectSamples(report.Rows);
    result.sampleRawRows = sampleRawRows;

    return result;
  } catch (err) {
    return { name: testName, error: err.message };
  }
}
