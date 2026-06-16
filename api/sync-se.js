// Gong → Notion sync for Sales Engineering
// Appends Gong call summaries into the "Meeting and call transcripts" toggle
// on each retailer's page in the "Retailers - Deals Discovery & Readiness" DB.
//
// Runs daily at 7am UTC via Vercel cron.
// Trigger manually: /api/sync-se?token=PROXY_SECRET&days=7
// Filter to one retailer: /api/sync-se?token=PROXY_SECRET&days=30&retailer=europris

const GONG_BASE = 'https://api.gong.io/v2';
const NOTION_BASE = 'https://api.notion.com/v1';

// Notion DB: "Retailers - Deals Discovery & Readiness"
const RETAILERS_DB_ID = '1f8a1680-dfbf-8128-990a-000b865e8e20';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gongHeaders() {
  const key = process.env.GONG_ACCESS_KEY;
  const secret = process.env.GONG_SECRET_KEY;
  if (!key || !secret) throw new Error('Missing GONG_ACCESS_KEY or GONG_SECRET_KEY');
  return {
    Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'),
    'Content-Type': 'application/json',
  };
}

function notionHeaders() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('Missing NOTION_TOKEN');
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Gong API
// ---------------------------------------------------------------------------

async function fetchGongCalls(fromDateTime, toDateTime) {
  const url = new URL(`${GONG_BASE}/calls`);
  url.searchParams.set('fromDateTime', fromDateTime);
  url.searchParams.set('toDateTime', toDateTime);

  const calls = [];
  let cursor;

  do {
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString(), { headers: gongHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gong calls list failed ${res.status}: ${body}`);
    }
    const data = await res.json();
    calls.push(...(data.calls || []));
    cursor = data.records?.cursor;
  } while (cursor);

  return calls;
}

async function fetchGongCallDetails(callIds) {
  // Fetch AI highlights (recap, key points, next steps) for a batch of calls
  const res = await fetch(`${GONG_BASE}/calls/extensive`, {
    method: 'POST',
    headers: gongHeaders(),
    body: JSON.stringify({
      filter: { callIds },
      contentSelector: {
        exposedFields: {
          content: { pointsOfInterest: true, keyPoints: true },
          parties: true,
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gong extensive calls failed ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.calls || [];
}

async function fetchGongHighlights(callId) {
  const res = await fetch(`${GONG_BASE}/calls/${callId}/highlights`, {
    headers: gongHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data;
}

// ---------------------------------------------------------------------------
// Notion API — Retailers DB
// ---------------------------------------------------------------------------

async function loadRetailers(retailerFilter) {
  const retailers = [];
  let cursor;

  do {
    const body = {
      filter: { property: 'Signed', checkbox: { equals: false } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`${NOTION_BASE}/databases/${RETAILERS_DB_ID}/query`, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion DB query failed ${res.status}: ${text}`);
    }
    const data = await res.json();

    for (const page of data.results || []) {
      const merchant = page.properties?.Merchant?.title?.[0]?.plain_text
        || page.properties?.Name?.title?.[0]?.plain_text
        || '';
      if (!merchant) continue;
      if (retailerFilter && !normalize(merchant).includes(normalize(retailerFilter))) continue;

      retailers.push({
        id: page.id,
        name: merchant,
        normalizedName: normalize(merchant),
      });
    }
    cursor = data.next_cursor;
  } while (cursor);

  return retailers;
}

// ---------------------------------------------------------------------------
// Notion API — Page blocks
// ---------------------------------------------------------------------------

async function getPageBlocks(pageId) {
  const blocks = [];
  let cursor;

  do {
    const url = new URL(`${NOTION_BASE}/blocks/${pageId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);

    const res = await fetch(url.toString(), { headers: notionHeaders() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Get blocks failed ${res.status}: ${text}`);
    }
    const data = await res.json();
    blocks.push(...(data.results || []));
    cursor = data.next_cursor;
  } while (cursor);

  return blocks;
}

function findTranscriptsBlock(blocks) {
  for (const block of blocks) {
    const type = block.type;
    if (!['heading_1', 'heading_2', 'heading_3'].includes(type)) continue;
    const richText = block[type]?.rich_text || [];
    const plainText = richText.map(t => t.plain_text).join('');
    if (plainText.includes('Meeting and call transcripts')) return block;
  }
  return null;
}

async function getToggleChildren(blockId) {
  const children = [];
  let cursor;

  do {
    const url = new URL(`${NOTION_BASE}/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);

    const res = await fetch(url.toString(), { headers: notionHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    children.push(...(data.results || []));
    cursor = data.next_cursor;
  } while (cursor);

  return children;
}

async function appendBlocksToToggle(toggleBlockId, blocks) {
  const res = await fetch(`${NOTION_BASE}/blocks/${toggleBlockId}/children`, {
    method: 'PATCH',
    headers: notionHeaders(),
    body: JSON.stringify({ children: blocks }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Append blocks failed ${res.status}: ${text}`);
  }
  return res.json();
}

async function updateRetailerSyncStatus(pageId) {
  const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(),
    body: JSON.stringify({
      properties: {
        'Sync status (auto)': { select: { name: 'Done' } },
        'Last synced on': { date: { start: new Date().toISOString() } },
      },
    }),
  });
  // Best-effort — don't throw if property doesn't exist
  if (!res.ok) console.warn(`Could not update sync status for page ${pageId}`);
}

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

function matchCallToRetailers(call, retailers) {
  const matched = [];

  // Strategy 1: email domain matching
  const participants = call.parties || [];
  const externalDomains = participants
    .filter(p => p.affiliation === 'External' && p.emailAddress)
    .map(p => {
      const domain = p.emailAddress.split('@')[1] || '';
      return normalize(domain.split('.')[0]); // e.g. "europris" from "europris.no"
    });

  for (const retailer of retailers) {
    for (const domain of externalDomains) {
      if (domain && retailer.normalizedName.includes(domain)) {
        matched.push(retailer);
        break;
      }
    }
  }

  if (matched.length > 0) return matched;

  // Strategy 2: call title matching (4+ char retailer name appears in title)
  const normalizedTitle = normalize(call.title || '');
  for (const retailer of retailers) {
    if (retailer.normalizedName.length >= 4 && normalizedTitle.includes(retailer.normalizedName)) {
      matched.push(retailer);
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Deduplication: check if this call is already in the toggle
// ---------------------------------------------------------------------------

function isDuplicate(existingChildren, dedupKey) {
  for (const block of existingChildren) {
    const type = block.type;
    const richText = block[type]?.rich_text || block[type]?.caption || [];
    const text = richText.map(t => t.plain_text).join('');
    if (text.includes(dedupKey)) return true;
    // Also check callout text
    if (block.type === 'callout') {
      const calloutText = block.callout?.rich_text?.map(t => t.plain_text).join('') || '';
      if (calloutText.includes(dedupKey)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build Notion blocks for one call
// ---------------------------------------------------------------------------

function buildCallBlocks(call, details) {
  const title = call.title || 'Untitled call';
  const date = call.scheduled
    ? new Date(call.scheduled).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : 'Unknown date';
  const gongUrl = call.url || `https://app.gong.io/call?id=${call.id}`;
  const dedupKey = `${title}|${call.scheduled || call.started || ''}`;

  const participants = (call.parties || [])
    .filter(p => p.name)
    .map(p => `${p.name}${p.affiliation === 'External' ? ' (ext)' : ''}`)
    .join(', ');

  const blocks = [];

  // Divider before each call entry
  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // Call heading toggle
  blocks.push({
    object: 'block',
    type: 'heading_3',
    heading_3: {
      is_toggleable: true,
      rich_text: [
        { type: 'text', text: { content: `📞 ${title} — ${date}` } },
      ],
      children: [
        // Metadata row
        {
          object: 'block',
          type: 'callout',
          callout: {
            icon: { type: 'emoji', emoji: '📋' },
            rich_text: [
              { type: 'text', text: { content: `Date: ${date}\n` } },
              participants
                ? { type: 'text', text: { content: `Participants: ${participants}\n` } }
                : null,
              { type: 'text', text: { content: 'Gong: ', annotations: {} } },
              { type: 'text', text: { content: gongUrl, link: { url: gongUrl } } },
              // Hidden dedup key (in an invisible annotation trick — store in the block text)
              { type: 'text', text: { content: `\n[dedup:${dedupKey}]` }, annotations: { color: 'default' } },
            ].filter(Boolean),
            color: 'gray_background',
          },
        },
        // AI highlights if available
        ...buildHighlightBlocks(details),
      ],
    },
  });

  return { blocks, dedupKey };
}

function buildHighlightBlocks(details) {
  if (!details) return [];
  const blocks = [];

  // Key points
  const keyPoints = details.content?.keyPoints || [];
  if (keyPoints.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: '🔑 Key points' } }] },
    });
    for (const kp of keyPoints.slice(0, 10)) {
      const text = typeof kp === 'string' ? kp : kp.text || kp.headline || JSON.stringify(kp);
      if (text) {
        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
        });
      }
    }
  }

  // Points of interest (action items / next steps)
  const poi = details.content?.pointsOfInterest || [];
  const nextSteps = poi.filter(p => p.category === 'NextSteps' || p.category === 'Action Items');
  if (nextSteps.length > 0) {
    blocks.push({
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: '✅ Next steps' } }] },
    });
    for (const ns of nextSteps.slice(0, 10)) {
      const text = ns.speakerActionItems?.[0]?.text || ns.text || '';
      if (text) {
        blocks.push({
          object: 'block',
          type: 'to_do',
          to_do: {
            rich_text: [{ type: 'text', text: { content: text } }],
            checked: false,
          },
        });
      }
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // Auth
  const token = req.query?.token || req.headers?.['x-proxy-secret'];
  if (token !== process.env.PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const days = Math.min(parseInt(req.query?.days || '1', 10), 90);
  const retailerFilter = req.query?.retailer || null;

  const toDateTime = new Date().toISOString();
  const fromDateTime = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const log = { from: fromDateTime, to: toDateTime, days, retailer_filter: retailerFilter };

  try {
    // 1. Load retailers
    const retailers = await loadRetailers(retailerFilter);
    log.retailers_loaded = retailers.length;
    if (retailers.length === 0) {
      return res.status(200).json({ ...log, message: 'No retailers found', synced: 0 });
    }

    // 2. Fetch Gong calls
    const calls = await fetchGongCalls(fromDateTime, toDateTime);
    log.gong_calls_fetched = calls.length;

    if (calls.length === 0) {
      return res.status(200).json({ ...log, message: 'No Gong calls in range', synced: 0 });
    }

    // 3. Match calls to retailers
    const matchedPairs = []; // { call, retailer }
    for (const call of calls) {
      const matched = matchCallToRetailers(call, retailers);
      for (const retailer of matched) {
        matchedPairs.push({ call, retailer });
      }
    }
    log.matched_pairs = matchedPairs.length;

    if (matchedPairs.length === 0) {
      return res.status(200).json({ ...log, message: 'No calls matched to retailers', synced: 0 });
    }

    // 4. Fetch AI highlights for matched calls (batch)
    const matchedCallIds = [...new Set(matchedPairs.map(p => p.call.id))];
    let detailsMap = {};
    if (matchedCallIds.length > 0) {
      try {
        const detailsArr = await fetchGongCallDetails(matchedCallIds);
        for (const d of detailsArr) {
          detailsMap[d.metaData?.id || d.id] = d;
        }
      } catch (e) {
        console.warn('Could not fetch call details:', e.message);
      }
    }

    // 5. For each matched pair, find the toggle block and append
    const results = { synced: 0, skipped_duplicate: 0, skipped_no_section: 0, errors: [] };
    const processedRetailers = new Set();

    for (const { call, retailer } of matchedPairs) {
      try {
        // Get page blocks (cache per retailer page)
        const pageBlocks = await getPageBlocks(retailer.id);
        const transcriptsBlock = findTranscriptsBlock(pageBlocks);

        if (!transcriptsBlock) {
          results.skipped_no_section++;
          results.errors.push(`No "Meeting and call transcripts" section in ${retailer.name}`);
          continue;
        }

        // Check for duplicates inside the toggle
        const toggleChildren = await getToggleChildren(transcriptsBlock.id);
        const details = detailsMap[call.id] || null;
        const { blocks, dedupKey } = buildCallBlocks(call, details);

        if (isDuplicate(toggleChildren, dedupKey)) {
          results.skipped_duplicate++;
          continue;
        }

        // Append to toggle
        await appendBlocksToToggle(transcriptsBlock.id, blocks);
        results.synced++;

        // Update sync status on the retailer page (once per retailer)
        if (!processedRetailers.has(retailer.id)) {
          processedRetailers.add(retailer.id);
          await updateRetailerSyncStatus(retailer.id);
        }
      } catch (err) {
        results.errors.push(`${retailer.name} / ${call.title}: ${err.message}`);
      }
    }

    return res.status(200).json({ ...log, ...results });
  } catch (err) {
    console.error('sync-se error:', err);
    return res.status(500).json({ ...log, error: err.message });
  }
}
