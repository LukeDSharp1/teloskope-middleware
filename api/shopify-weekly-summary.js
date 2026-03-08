// api/shopify-weekly-summary.js
// Vercel serverless function — pulls Shopify weekly data and posts to Bubble

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { shop_domain, access_token, bubble_secret_key, user_id } = req.body;

  if (!shop_domain || !access_token || !bubble_secret_key || !user_id) {
    return res.status(400).json({ error: 'Missing required fields: shop_domain, access_token, bubble_secret_key, user_id' });
  }

  try {
    // ─── Date calculations (Mon–Sun weeks) ───────────────────────────────────

    const now = new Date();

    // Start of current week (Monday)
    const dayOfWeek = now.getDay(); // 0 = Sun, 1 = Mon ...
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysFromMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // Prior comparable week (same Mon–Sun, last year)
    const pcwStart = new Date(weekStart);
    pcwStart.setFullYear(pcwStart.getFullYear() - 1);
    const pcwEnd = new Date(weekEnd);
    pcwEnd.setFullYear(pcwEnd.getFullYear() - 1);

    // MTD
    const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
    mtdStart.setHours(0, 0, 0, 0);
    const mtdEnd = new Date(now);
    mtdEnd.setHours(23, 59, 59, 999);

    // LY MTD — same date range, last year
    const lyMtdStart = new Date(mtdStart);
    lyMtdStart.setFullYear(lyMtdStart.getFullYear() - 1);
    const lyMtdEnd = new Date(mtdEnd);
    lyMtdEnd.setFullYear(lyMtdEnd.getFullYear() - 1);

    // YTD
    const ytdStart = new Date(now.getFullYear(), 0, 1);
    ytdStart.setHours(0, 0, 0, 0);

    // LY YTD
    const lyYtdStart = new Date(ytdStart);
    lyYtdStart.setFullYear(lyYtdStart.getFullYear() - 1);
    const lyYtdEnd = new Date(now);
    lyYtdEnd.setFullYear(lyYtdEnd.getFullYear() - 1);
    lyYtdEnd.setHours(23, 59, 59, 999);

    const fmt = (d) => d.toISOString();

    // ─── Shopify API helper ───────────────────────────────────────────────────

    const shopifyFetch = async (endpoint) => {
      const url = `https://${shop_domain}/admin/api/2024-01/${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': access_token,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Shopify API error ${response.status} on ${endpoint}: ${text}`);
      }
      return response.json();
    };

    // Orders endpoint builder — financial_status=paid ensures we count real revenue
    const ordersQuery = (start, end, fields = 'total_price,created_at') =>
      `orders.json?status=any&financial_status=paid&created_at_min=${fmt(start)}&created_at_max=${fmt(end)}&fields=${fields}&limit=250`;

    // ─── Fetch all pages for a query ─────────────────────────────────────────

    const fetchAllOrders = async (start, end, fields = 'total_price,created_at') => {
      let orders = [];
      let url = `https://${shop_domain}/admin/api/2024-01/orders.json?status=any&financial_status=paid&created_at_min=${fmt(start)}&created_at_max=${fmt(end)}&fields=${fields}&limit=250`;

      while (url) {
        const response = await fetch(url, {
          headers: {
            'X-Shopify-Access-Token': access_token,
            'Content-Type': 'application/json',
          },
        });
        if (!response.ok) throw new Error(`Shopify paginate error ${response.status}`);
        const data = await response.json();
        orders = orders.concat(data.orders || []);

        // Check for next page via Link header
        const linkHeader = response.headers.get('Link');
        if (linkHeader && linkHeader.includes('rel="next"')) {
          const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          url = match ? match[1] : null;
        } else {
          url = null;
        }
      }
      return orders;
    };

    // ─── Parallel fetches ────────────────────────────────────────────────────

    const [
      weekOrders,
      pcwOrders,
      mtdOrders,
      lyMtdOrders,
      ytdOrders,
      lyYtdOrders,
      weekOrdersForProducts,
    ] = await Promise.all([
      fetchAllOrders(weekStart, weekEnd, 'total_price,created_at'),
      fetchAllOrders(pcwStart, pcwEnd, 'total_price,created_at'),
      fetchAllOrders(mtdStart, mtdEnd, 'total_price,created_at,customer'),
      fetchAllOrders(lyMtdStart, lyMtdEnd, 'total_price,created_at,customer'),
      fetchAllOrders(ytdStart, mtdEnd, 'total_price,created_at'),
      fetchAllOrders(lyYtdStart, lyYtdEnd, 'total_price,created_at'),
      fetchAllOrders(weekStart, weekEnd, 'line_items'),
    ]);

    // ─── Calculators ─────────────────────────────────────────────────────────

    const sumRevenue = (orders) =>
      orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

    const calcAov = (orders) => {
      const count = orders.length;
      return count > 0 ? sumRevenue(orders) / count : 0;
    };

    // New vs returning: if customer.orders_count === 1 at time of order, they're new
    // Best proxy available via orders API — customers with orders_count = 1
    const countNewReturning = (orders) => {
      let newC = 0, returning = 0;
      for (const order of orders) {
        const ordersCount = order.customer?.orders_count ?? 1;
        if (ordersCount <= 1) newC++;
        else returning++;
      }
      return { newC, returning };
    };

    // Top 5 products by quantity this week
    const productMap = {};
    for (const order of weekOrdersForProducts) {
      for (const item of order.line_items || []) {
        const key = item.product_id;
        if (!productMap[key]) {
          productMap[key] = { product_id: key, title: item.title, quantity: 0 };
        }
        productMap[key].quantity += item.quantity;
      }
    }
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5)
      .map(({ title, quantity }) => ({ title, quantity }));

    // ─── Assemble results ────────────────────────────────────────────────────

    const { newC: newMtd, returning: returningMtd } = countNewReturning(mtdOrders);
    const { newC: newLyMtd, returning: returningLyMtd } = countNewReturning(lyMtdOrders);

    const weekRevenue = sumRevenue(weekOrders);
    const pcwRevenue = sumRevenue(pcwOrders);
    const mtdRevenue = sumRevenue(mtdOrders);
    const lyMtdRevenue = sumRevenue(lyMtdOrders);
    const ytdRevenue = sumRevenue(ytdOrders);
    const lyYtdRevenue = sumRevenue(lyYtdOrders);

    const weekTxCount = weekOrders.length;
    const pcwTxCount = pcwOrders.length;
    const mtdTxCount = mtdOrders.length;
    const lyMtdTxCount = lyMtdOrders.length;

    const weekAov = calcAov(weekOrders);
    const pcwAov = calcAov(pcwOrders);

    // sync_id format: shopify_{user_id}_{weekStart ISO date}
    const syncId = `shopify_${user_id}_${weekStart.toISOString().split('T')[0]}`;

    // ─── POST to Bubble ───────────────────────────────────────────────────────

    const bubblePayload = {
      secret_key: bubble_secret_key,
      sync_id: syncId,
      user_id,
      source: 'shopify',
      week_start_date: weekStart.toISOString(),
      week_end_date: weekEnd.toISOString(),

      // This week
      sales_total: Math.round(weekRevenue * 100) / 100,
      transaction_count: weekTxCount,
      aov: Math.round(weekAov * 100) / 100,

      // PCW (prior comparable week = same week last year)
      sales_total_ly_week: Math.round(pcwRevenue * 100) / 100,
      transaction_count_ly_week: pcwTxCount,
      aov_ly_week: Math.round(pcwAov * 100) / 100,

      // MTD
      sales_total_mtd: Math.round(mtdRevenue * 100) / 100,
      transaction_count_mtd: mtdTxCount,
      sales_total_ly_mtd: Math.round(lyMtdRevenue * 100) / 100,
      transaction_count_ly_mtd: lyMtdTxCount,

      // YTD
      sales_total_ytd: Math.round(ytdRevenue * 100) / 100,
      sales_total_ly_ytd: Math.round(lyYtdRevenue * 100) / 100,

      // New vs returning (MTD)
      new_customers_mtd: newMtd,
      returning_customers_mtd: returningMtd,
      new_customers_ly_mtd: newLyMtd,
      returning_customers_ly_mtd: returningLyMtd,

      // Top products
      top_products_json: JSON.stringify(topProducts),
    };

    const bubbleResponse = await fetch(
      'https://teloskope.bubbleapps.io/version-test/api/1.1/wf/ingest_weekly_shopify_summary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bubblePayload),
      }
    );

    if (!bubbleResponse.ok) {
      const bubbleError = await bubbleResponse.text();
      throw new Error(`Bubble ingest failed: ${bubbleResponse.status} — ${bubbleError}`);
    }

    return res.status(200).json({
      success: true,
      sync_id: syncId,
      week_start: weekStart.toISOString().split('T')[0],
      week_end: weekEnd.toISOString().split('T')[0],
      summary: {
        week_revenue: weekRevenue,
        pcw_revenue: pcwRevenue,
        mtd_revenue: mtdRevenue,
        ytd_revenue: ytdRevenue,
        week_transactions: weekTxCount,
        week_aov: weekAov,
        top_products: topProducts,
        new_customers_mtd: newMtd,
        returning_customers_mtd: returningMtd,
      },
    });

  } catch (err) {
    console.error('shopify-weekly-summary error:', err);
    return res.status(500).json({ error: err.message });
  }
}
