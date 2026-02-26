# Model API Interaction Guide

This document explains how this project interacts with model APIs, what parameters are used, and how to debug behavior.

## Entry Point

The main orchestration code is in:

- `/Users/zhiqiang/Code/calendar-ai/src/app/actions.tsx`

The server action `submitMessage(question, threadId)` handles one user interaction end-to-end.

## End-to-End Flow

1. User sends a message from chat UI.
2. `submitMessage` validates session and Google access token.
3. It creates streamable channels (`status`, `text`, `gui`, `refetch` streams).
4. It calls `extractTimeRangeFromQuestion()` (model call #1).
5. It runs a multi-round assistant loop (model call #2, up to `MAX_TOOL_ROUNDS`).
6. If model returns tool calls, backend executes Google Calendar actions.
7. Tool outputs are appended to conversation history and fed back to model.
8. Final assistant text is streamed back to client.

## Model Client Initialization

The OpenAI-compatible client is initialized as:

- `OPENAI_API_KEY`: API key
- `OPENAI_BASE_URL` (optional): custom compatible endpoint (for non-OpenAI providers)

Code location:

- `/Users/zhiqiang/Code/calendar-ai/src/app/actions.tsx`

## Model Call #1: Time Range Extraction

Function:

- `extractTimeRangeFromQuestion(question)`

API:

- `openai.chat.completions.create(body, options)`

Parameters and meaning:

- `model`: `TIME_RANGE_MODEL`  
  Model used only for extracting time range.
- `temperature: 0`  
  Deterministic output, lower randomness.
- `response_format: { type: 'json_object' }`  
  Forces JSON-style output.
- `messages`:
  - `system`: extraction rules (`{start,end}` or nulls)
  - `user`: current time + user query
- `options.timeout`: `OPENAI_REQUEST_TIMEOUT_MS`  
  Hard timeout for this request.
- `options.maxRetries: 0`  
  No retry; fail fast to avoid long hangs.

Expected response shape:

- `{"start":"ISO8601","end":"ISO8601"}` or null values.

Failure handling:

- Timeout/parse failure returns `null`.
- Flow continues (no hard crash).

## Model Call #2: Main Assistant Reasoning Loop

Location:

- inside `submitMessage`, in the `for (round...)` loop

API:

- `openai.chat.completions.create(body, options)`

Parameters and meaning:

- `model`: `ASSISTANT_MODEL`
- `temperature: 0.2`  
  Slight creativity while preserving stability.
- `tool_choice: 'auto'`  
  Model decides whether to call tools.
- `tools`: function schemas loaded from `assistant/functions/*.json`
- `messages`:
  - first system message = assistant instruction + runtime context
  - then conversation `history` (user/assistant/tool messages)
- `options.timeout`: `OPENAI_REQUEST_TIMEOUT_MS`
- `options.maxRetries: 0`

Response fields used:

- `choices[0].message.content`: normal assistant text
- `choices[0].message.tool_calls`: requested tool calls
- `choices[0].finish_reason`: round stop reason (logged)

## Tool Definitions Passed to Model

Loaded dynamically from:

- `/Users/zhiqiang/Code/calendar-ai/assistant/functions/get_calendar.json`
- `/Users/zhiqiang/Code/calendar-ai/assistant/functions/schedule_event.json`
- `/Users/zhiqiang/Code/calendar-ai/assistant/functions/edit_event.json`
- `/Users/zhiqiang/Code/calendar-ai/assistant/functions/delete_event.json`

These schemas determine which function names and argument structures the model can emit.

## Tool Execution (Backend)

Executor function:

- `executeCalendarTool(toolCall, calendar, userEmail, gui)`

Implemented tools:

- `get_calendar` -> `calendar.events.list`
- `schedule_event` -> `calendar.events.insert`
- `edit_event` -> `calendar.events.update`
- `delete_event` -> `calendar.events.delete`

Important behavior:

- Mutation tools increment `refetchJobsStream`.
- Errors are normalized by `formatToolError()` and returned to model/client.
- Success can include links like `htmlLink` in GUI updates.

## Clarification Gate (Ambiguous / No-Action Requests)

Before executing mutation tools, the system checks:

- explicit no-action phrases (e.g. "先不要操作")
- ambiguous planning intent (e.g. "最近", "左右", "未来这段时间")

When triggered:

- tool execution is blocked
- assistant asks follow-up questions first
- no pending `tool_calls` are left in history

Core functions:

- `shouldAskClarificationBeforeMutation(...)`
- `buildClarificationPrompt()`

## Streaming Objects Sent to Client

In `submitMessage`, streams include:

- `status`: phase updates
- `text`: assistant text tokens
- `gui`: tool execution status UI
- `threadIdStream`: current thread id
- `refetchJobsStream`: mutation counter
- `refetchRangeStream`: extracted range (or null)

Client readers are implemented in:

- `/Users/zhiqiang/Code/calendar-ai/src/components/chat.tsx`

## Logging and Debugging

Structured logs use prefix:

- `[calendar-ai][ai-interaction]`

Key stages:

- `request-start`
- `range-extract-start|success|failed|invalid-json`
- `range-extracted`
- `assistant-config-loaded`
- `model-response`
- `tool-call-start`
- `tool-call-result`
- `clarification-required`
- `final-response`
- `request-complete`
- `request-error`

These logs allow quick attribution:

- Model/network issue -> extract/model timeout or request error
- Prompt/tool planning issue -> model-response content/toolCalls
- Execution issue -> tool-call-result with `outputError`
- UI sync issue -> streams/refetch behavior in client

## Runtime Config Variables

Relevant environment variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` (optional)
- `ASSISTANT_MODEL`
- `TIME_RANGE_MODEL`
- `OPENAI_REQUEST_TIMEOUT_MS` (optional, default `20000`)
- `ASSISTANT_ID` (legacy; no longer required by current chat-completions loop)

