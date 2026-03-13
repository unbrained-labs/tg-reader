# TG Reader — Agent Evaluation Prompt

Give this entire document to a Claude agent (with the tg-reader MCP connected).
The agent should run every task, record results, and produce a RESULTS section at the end.

---

## Your job

You are evaluating the tg-reader MCP service. Run each task below in order.
For every task, record:
- **Tools called** (in order)
- **Round-trips** (number of MCP calls made)
- **Latency** (approximate — note if a call felt slow)
- **Result quality** (did you get a useful, correct answer?)
- **Friction** (anything confusing, missing, or requiring a workaround)

Do NOT fake results. If a task fails or returns nothing useful, say so.

---

## Tasks

### Group A — Basic retrieval (no chaining required)

**A1. Archive overview**
> "How many messages are in the archive? What's the date range?"

**A2. List active chats**
> "What are the 5 most active chats?"

**A3. Simple search**
> "Find messages mentioning 'airdrop'"

**A4. Date-scoped search**
> "Find messages about 'liquidity' from the last 3 months"

**A5. Recent activity**
> "What happened in the last 24 hours across all chats?"

---

### Group B — Multi-step retrieval (chaining required)

**B1. Person lookup → search**
> "Find all messages from whoever sent the most messages in the Cybertim VC/OTC chat"
(Expected path: history or search to find top sender → search filtered by sender_username)

**B2. Chat discovery → history**
> "Show me the first 10 messages ever in the MadHoney coordination chat"
(Expected path: chats to get chat_id → history with no cursor)

**B3. Thread reconstruction**
> "Find a message with replies in the Berachain Buildoooors Reborn chat and show me the thread"
(Expected path: search or history to find message → thread)

**B4. Cross-chat person**
> "Find everything sent by user 'erolfi' across all chats"
(Expected path: contacts or search with sender_username)

**B5. Catch-up digest**
> "Give me a briefing of the last week across all chats, grouped by chat"
(Expected path: digest(hours=168))

---

### Group C — Reasoning over retrieved data

**C1. Summarise a conversation**
> "What was the main topic of discussion in Bera Slot over the last month?"
(Agent must retrieve messages then reason over them)

**C2. Find a decision**
> "Was there any discussion about token listings or partnerships in MadHoney coordination?"
(Agent must search and interpret results)

**C3. Count and compare**
> "Who sent more messages overall — incoming or outgoing? By how much?"
(Agent should use stats tool, not manually count)

**C4. Timeline reconstruction**
> "What was happening in Berachain Buildoooors Reborn in August 2024?"
(Agent must use date filtering correctly)

---

### Group D — Write operations
> ⚠️ These create real drafts. Do NOT use send — draft only.

**D1. Draft a message**
> "Draft a message to the Telegram system chat (777000) saying 'test from agent evaluation'"

**D2. Draft with placeholder**
> "Draft a mass message to 3 fake recipients: {first_name}, here's your weekly update."
Use these fake recipients:
- `{"tg_chat_id": "111", "first_name": "Alice"}`
- `{"tg_chat_id": "222", "first_name": "Bob"}`
- `{"tg_chat_id": "333", "first_name": "Carol"}`

---

### Group E — Edge cases & stress

**E1. Empty search**
> "Find messages about 'xyznonexistentterm9999'"
(Expect: graceful empty result, no error)

**E2. Very broad search**
> "Find messages containing 'ok'"
(Measure: does it paginate correctly? How many total results?)

**E3. Ambiguous intent**
> "What did people say recently?"
(Measure: does the agent pick digest or recent or search? Which is most useful?)

**E4. Pagination**
> "Find all messages mentioning 'token' — get at least 3 pages"
(Measure: does pagination work correctly end-to-end?)

---

## Measurements to record

For each group, record this table:

| Task | Tools used | Round-trips | Got useful answer? | Friction / notes |
|------|-----------|-------------|-------------------|-----------------|
| A1 | | | | |
| ... | | | | |

Then add an overall section:

### Scores (1–5)

| Dimension | Score | Notes |
|-----------|-------|-------|
| Tool routing accuracy | | Did you pick the right tool first time? |
| Response quality | | Were answers complete and correct? |
| Latency | | Did any calls feel slow? |
| Pagination usability | | Easy to navigate multi-page results? |
| Write tool clarity | | Were draft/send instructions clear? |
| Missing capabilities | | What would have made tasks easier? |

### Top 3 friction points
1.
2.
3.

### Top 3 things that worked well
1.
2.
3.

### Suggested improvements
(Be specific — tool X should do Y, response Z should include field W)
