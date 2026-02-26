'use server'

import { generateId } from 'ai'
import {
  createAI,
  createStreamableUI,
  createStreamableValue,
  StreamableValue,
} from 'ai/rsc'
import { OpenAI } from 'openai'
import { ReactNode } from 'react'
import { getServerSession } from 'next-auth'
import authOptions from '@/app/api/auth/[...nextauth]/authOptions'
import { google } from 'googleapis'
import { EventInput } from '@fullcalendar/core/index.js'
import { Message } from '@/components/message'
import { Check, Loader2, X } from 'lucide-react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
})

export interface ClientMessage {
  id: string
  status: ReactNode
  text: ReactNode
  gui: ReactNode
  threadIdStream?: StreamableValue<string, any>
  refetchJobsStream?: StreamableValue<number, any>
  refetchRangeStream?: StreamableValue<TimeRange | null, any>
}

type TimeRange = { start: string; end: string }

type ToolCallLike = {
  id?: string
  function: {
    name: string
    arguments?: string
  }
}

type ToolSchema = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
  }
}

const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || 'gpt-4o-mini'
const TIME_RANGE_MODEL = process.env.TIME_RANGE_MODEL || ASSISTANT_MODEL
const OPENAI_REQUEST_TIMEOUT_MS = Number(
  process.env.OPENAI_REQUEST_TIMEOUT_MS || 20000,
)

const MAX_TOOL_ROUNDS = 8
const conversationStore = new Map<string, any[]>()
let assistantConfigPromise: Promise<{ instructions: string; tools: ToolSchema[] }> | null = null

const AI_LOG_PREFIX = '[calendar-ai][ai-interaction]'

function truncateForLog(value: unknown, max = 600): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value)
          } catch {
            return String(value)
          }
        })()

  if (text.length <= max) return text
  return `${text.slice(0, max)}...<truncated ${text.length - max} chars>`
}

function logAIInteraction(stage: string, payload: Record<string, unknown>) {
  console.log(`${AI_LOG_PREFIX} ${stage}`, payload)
}

function formatToolError(error: unknown): string {
  const fallback = 'Tool execution failed'

  if (!error || typeof error !== 'object') {
    return fallback
  }

  const maybeError = error as {
    message?: string
    code?: string | number
    status?: number
    response?: {
      status?: number
      statusText?: string
      data?: {
        error?: {
          code?: number
          message?: string
          status?: string
          errors?: Array<{ reason?: string; message?: string }>
        }
      }
    }
  }

  const status = maybeError.response?.status ?? maybeError.status
  const statusText = maybeError.response?.statusText
  const apiError = maybeError.response?.data?.error
  const reasons =
    apiError?.errors
      ?.map((item) => item.reason || item.message)
      .filter(Boolean)
      .join(', ') || ''

  const parts = [
    status ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : '',
    apiError?.status ? `status=${apiError.status}` : '',
    apiError?.code ? `code=${apiError.code}` : '',
    maybeError.code ? `err=${String(maybeError.code)}` : '',
    apiError?.message || maybeError.message || fallback,
    reasons ? `reason=${reasons}` : '',
  ].filter(Boolean)

  return parts.join(' | ')
}

async function loadAssistantConfig() {
  if (assistantConfigPromise) return assistantConfigPromise

  assistantConfigPromise = (async () => {
    const instructionPath = path.join(
      process.cwd(),
      'assistant',
      'instruction.txt',
    )
    const functionsDir = path.join(process.cwd(), 'assistant', 'functions')
    const functionFiles = [
      'get_calendar.json',
      'schedule_event.json',
      'edit_event.json',
      'delete_event.json',
    ]

    const [instructions, ...functions] = await Promise.all([
      readFile(instructionPath, 'utf-8'),
      ...functionFiles.map((file) =>
        readFile(path.join(functionsDir, file), 'utf-8'),
      ),
    ])

    const tools = functions.map((fn) => ({
      type: 'function' as const,
      function: JSON.parse(fn),
    }))

    return { instructions, tools }
  })()

  try {
    return await assistantConfigPromise
  } catch (error) {
    assistantConfigPromise = null
    throw error
  }
}

async function extractTimeRangeFromQuestion(
  question: string,
): Promise<TimeRange | null> {
  const nowIso = new Date().toISOString()
  logAIInteraction('range-extract-start', {
    model: TIME_RANGE_MODEL,
    timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    question: truncateForLog(question, 800),
  })

  let response
  try {
    response = await openai.chat.completions.create(
      {
        model: TIME_RANGE_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Extract a calendar time range from user text. Return JSON only with { "start": ISO8601 string, "end": ISO8601 string } when a time range is clearly inferable. If unclear or absent, return { "start": null, "end": null }. Use UTC ISO8601 format and ensure end is after start.',
          },
          {
            role: 'user',
            content: `Now: ${nowIso}\nUser text: ${question}`,
          },
        ],
      },
      {
        timeout: OPENAI_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      },
    )
  } catch (error) {
    logAIInteraction('range-extract-failed', {
      model: TIME_RANGE_MODEL,
      timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
      error: truncateForLog(
        {
          message: (error as any)?.message,
          name: (error as any)?.name,
        },
        1000,
      ),
    })
    return null
  }

  const content = response.choices[0]?.message?.content
  if (!content) return null

  try {
    const parsed = JSON.parse(content) as {
      start?: string | null
      end?: string | null
    }

    if (!parsed.start || !parsed.end) return null

    const startDate = new Date(parsed.start)
    const endDate = new Date(parsed.end)

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return null
    }

    if (endDate <= startDate) return null

    const extracted = {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    }
    logAIInteraction('range-extract-success', {
      extracted,
    })
    return extracted
  } catch {
    logAIInteraction('range-extract-invalid-json', {
      content: truncateForLog(content, 800),
    })
    return null
  }
}

function parseArgs(args?: string) {
  if (!args) return {}

  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

function shouldAskClarificationBeforeMutation(
  question: string,
  extractedRange: TimeRange | null,
  executableToolCalls: ToolCallLike[],
): boolean {
  const toolNames = executableToolCalls.map((call) => call.function.name)
  const hasMutationTool = toolNames.some((name) =>
    ['schedule_event', 'edit_event', 'delete_event'].includes(name),
  )
  if (!hasMutationTool) return false

  const noActionPatterns = [
    /先不要操作/,
    /先别操作/,
    /先不要安排/,
    /先不要创建/,
    /先不创建/,
    /不要执行/,
    /先和我互动/,
    /don't\s+(?:operate|execute|schedule|book|create)/i,
  ]
  if (noActionPatterns.some((p) => p.test(question))) {
    return true
  }

  const hasSufficientMutationArgs = executableToolCalls.every((toolCall) => {
    const name = toolCall.function.name
    const args = parseArgs(toolCall.function.arguments) as Record<string, any>

    if (name === 'schedule_event') {
      return Boolean(args.start_time && args.end_time && args.summary)
    }

    if (name === 'edit_event') {
      return Boolean(
        args.event_id && args.start_time && args.end_time && args.summary,
      )
    }

    if (name === 'delete_event') {
      return Boolean(args.event_id)
    }

    return true
  })

  // If tool arguments are concrete and executable, don't block on extractedRange.
  if (hasSufficientMutationArgs) {
    return false
  }

  const schedulingIntentPatterns = [
    /安排/,
    /预约/,
    /schedule/i,
    /book/i,
    /复习/,
    /准备面试/,
    /面试准备/,
  ]
  const ambiguousPatterns = [
    /左右/,
    /最近/,
    /未来这段时间/,
    /这段时间/,
    /有空/,
    /抽时间/,
    /大概/,
    /差不多/,
    /around/i,
    /sometime/i,
    /soon/i,
  ]

  const hasSchedulingIntent = schedulingIntentPatterns.some((p) =>
    p.test(question),
  )
  const hasAmbiguousTime = ambiguousPatterns.some((p) => p.test(question))

  return hasSchedulingIntent && (hasAmbiguousTime || !extractedRange)
}

function buildClarificationPrompt(): string {
  return [
    '在我创建或修改日程之前，我先确认几个关键信息：',
    '1. 计划从哪天开始，到哪天结束？',
    '2. 每周准备几次？每次多长时间？',
    '3. 你偏好的时间段是哪些（如工作日晚上、周末上午）？',
    '4. 是否要避开已有日程并自动找空档？',
    '5. 是否需要提前提醒（提前多久）？',
    '你回复这些信息后，我再执行具体安排。',
  ].join('\n')
}

async function executeCalendarTool(
  toolCall: ToolCallLike,
  calendar: ReturnType<typeof google.calendar>,
  userEmail?: string | null,
  gui?: ReturnType<typeof createStreamableUI>,
): Promise<{ output: string; didMutate: boolean }> {
  const { function: fn } = toolCall
  const name = fn.name
  const args = parseArgs(fn.arguments)

  const actionTranslated: Record<string, string> = {
    schedule_event: 'Schedul',
    edit_event: 'Edit',
    delete_event: 'Delet',
    get_calendar: 'Consult',
  }

  gui?.append(
    <>
      <p className="flex gap-2 items-center">
        <Loader2 className="animate-spin" size={16} />
        {(actionTranslated[name] || 'Process')}ing events
      </p>
    </>,
  )

  const resolvePrimaryCalendarTimeZone = async () => {
    try {
      const primary = await calendar.calendars.get({ calendarId: 'primary' })
      return primary.data.timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }

  try {
    if (name === 'get_calendar') {
      const { start_time, end_time, calendar_id } = args as any
      const start = new Date(start_time).toISOString()
      const end = new Date(end_time).toISOString()

      const response = await calendar.events.list({
        calendarId: calendar_id || 'primary',
        timeMin: start,
        timeMax: end,
        singleEvents: true,
        orderBy: 'startTime',
      })

      const events: EventInput[] = (response.data.items || []).map((event) => ({
        id: event.id!,
        title: event.summary || 'Busy',
        start: event.start?.dateTime! || event.start?.date!,
        end: event.end?.dateTime! || event.end?.date!,
        allDay: !event.start?.dateTime,
        extendedProps: {
          description: event.description || '',
          attendees: event.attendees?.map((attendee) => attendee.email) || [],
          recurrence: event.recurrence || [],
          hangoutLink: event.hangoutLink || '',
          videoConferenceLink:
            event.conferenceData?.entryPoints?.find(
              (ep) => ep.entryPointType === 'video',
            )?.uri || '',
          responseStatus: event.status,
        },
      }))

      gui?.update(
        <>
          <p className="flex gap-2 items-center">
            <Check size={16} />
            Consulted events
          </p>
        </>,
      )

      return {
        output: JSON.stringify({ data: events }),
        didMutate: false,
      }
    }

    if (name === 'schedule_event') {
      const {
        start_time,
        end_time,
        summary,
        description,
        all_day,
        attendees,
        recurrence,
        time_zone,
      } = args as any

      const eventTimeZone = time_zone || (await resolvePrimaryCalendarTimeZone())
      const start = String(start_time)
      const end = String(end_time)
      const startDateOnly = start.includes('T') ? start.split('T')[0] : start
      const endDateOnly = end.includes('T') ? end.split('T')[0] : end

      const attendeesWithSelf = attendees?.length
        ? [...attendees, userEmail].filter(Boolean)
        : []

      const result = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary,
          description,
          start: {
            dateTime: all_day ? undefined : start,
            date: all_day ? startDateOnly : undefined,
            timeZone: eventTimeZone,
          },
          end: {
            dateTime: all_day ? undefined : end,
            date: all_day ? endDateOnly : undefined,
            timeZone: eventTimeZone,
          },
          attendees: attendeesWithSelf?.map((email: string) => ({
            email,
          })),
          recurrence,
        },
      })

      gui?.update(
        <>
          <p className="flex gap-2 items-center">
            <Check size={16} />
            Scheduled events
          </p>
          {result.data.htmlLink ? (
            <p className="text-sm text-muted-foreground break-words">
              {result.data.htmlLink}
            </p>
          ) : null}
        </>,
      )

      return {
        output: JSON.stringify({ data: result.data }),
        didMutate: true,
      }
    }

    if (name === 'edit_event') {
      const {
        start_time,
        end_time,
        summary,
        description,
        all_day,
        attendees,
        recurrence,
        event_id,
      } = args as any

      const eventTimeZone = await resolvePrimaryCalendarTimeZone()
      const start = start_time ? String(start_time) : undefined
      const end = end_time ? String(end_time) : undefined
      const startDateOnly =
        start && start.includes('T') ? start.split('T')[0] : start
      const endDateOnly = end && end.includes('T') ? end.split('T')[0] : end

      const result = await calendar.events.update({
        calendarId: 'primary',
        eventId: event_id,
        requestBody: {
          summary,
          description,
          start: {
            dateTime: all_day ? undefined : start,
            date: all_day ? startDateOnly : undefined,
            timeZone: eventTimeZone,
          },
          end: {
            dateTime: all_day ? undefined : end,
            date: all_day ? endDateOnly : undefined,
            timeZone: eventTimeZone,
          },
          attendees: attendees?.map((email: string) => ({ email })),
          recurrence,
        },
      })

      gui?.update(
        <>
          <p className="flex gap-2 items-center">
            <Check size={16} />
            Edited events
          </p>
        </>,
      )

      return {
        output: JSON.stringify({ data: result.data }),
        didMutate: true,
      }
    }

    if (name === 'delete_event') {
      const { event_id } = args as any

      const result = await calendar.events.delete({
        calendarId: 'primary',
        eventId: event_id,
      })

      gui?.update(
        <>
          <p className="flex gap-2 items-center">
            <Check size={16} />
            Deleted events
          </p>
        </>,
      )

      return {
        output: JSON.stringify({ data: result.data }),
        didMutate: true,
      }
    }

    gui?.update(
      <>
        <p className="flex gap-2 items-center">
          <X size={16} className="text-destructive" />
          Unsupported tool: {name}
        </p>
      </>,
    )

    return {
      output: JSON.stringify({ error: `Unsupported tool: ${name}` }),
      didMutate: false,
    }
  } catch (error: unknown) {
    const detail = formatToolError(error)
    console.error('[calendar-ai] tool execution error', {
      detail,
      raw: error,
    })

    gui?.update(
      <>
        <p className="flex gap-2 items-center">
          <X size={16} className="text-destructive" />
          Tool action failed
        </p>
        <p className="text-sm text-muted-foreground break-words">{detail}</p>
      </>,
    )

    return {
      output: JSON.stringify({ error: detail }),
      didMutate: false,
    }
  }
}

export async function submitMessage(
  question: string,
  threadId: string,
): Promise<ClientMessage> {
  try {
    const session = await getServerSession(authOptions)

    if (!session || !session.accessToken) {
      return {
        id: generateId(),
        status: '',
        text: 'Not authenticated',
        gui: null,
      }
    }

    const oauth2Client = new google.auth.OAuth2()

    oauth2Client.setCredentials({
      access_token: session.accessToken,
    })

    const calendar = google.calendar({
      version: 'v3',
      auth: oauth2Client,
    })

    const status = createStreamableUI('conversation.init')
    const textStream = createStreamableValue('')
    const textUIStream = createStreamableUI(
      <Message textStream={textStream.value} />,
    )
    const gui = createStreamableUI()

    const normalizedThreadId = threadId || generateId()
    const threadIdStream = createStreamableValue(normalizedThreadId)
    const refetchJobsStream = createStreamableValue(0)
    const refetchRangeStream = createStreamableValue<TimeRange | null>(null)

    ;(async () => {
      try {
        logAIInteraction('request-start', {
          threadId: normalizedThreadId,
          user: session.user?.email || session.user?.name || 'unknown',
          question: truncateForLog(question, 1000),
        })

        status.update('conversation.extract_range')
        const extractedRange = await extractTimeRangeFromQuestion(question)
        refetchRangeStream.update(extractedRange)
        logAIInteraction('range-extracted', {
          threadId: normalizedThreadId,
          extractedRange,
        })

        const { instructions, tools } = await loadAssistantConfig()
        logAIInteraction('assistant-config-loaded', {
          threadId: normalizedThreadId,
          tools: tools.map((tool) => tool.function.name),
        })

        const history = [...(conversationStore.get(normalizedThreadId) || [])]
        history.push({ role: 'user', content: question })

        let refetchJobs = 0

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          status.update(`conversation.model_round_${round + 1}`)

          const completion = await openai.chat.completions.create(
            {
              model: ASSISTANT_MODEL,
              temperature: 0.2,
              tool_choice: 'auto',
              tools,
              messages: [
                {
                  role: 'system',
                  content: `${instructions}\n<current_time>${new Date().toISOString()}</current_time><current_user>${session.user?.name}</current_user>`,
                },
                ...history,
              ],
            },
            {
              timeout: OPENAI_REQUEST_TIMEOUT_MS,
              maxRetries: 0,
            },
          )

          const assistantMessage = completion.choices[0]?.message

          if (!assistantMessage) {
            textStream.append('No response from model.')
            logAIInteraction('model-empty-response', {
              threadId: normalizedThreadId,
              round: round + 1,
            })
            break
          }

          const toolCalls = (assistantMessage.tool_calls || []) as ToolCallLike[]
          const legacyFunctionCall = (assistantMessage as any).function_call as
            | { name: string; arguments?: string }
            | undefined
          logAIInteraction('model-response', {
            threadId: normalizedThreadId,
            round: round + 1,
            finishReason: completion.choices[0]?.finish_reason || null,
            content: truncateForLog(assistantMessage.content || '', 1200),
            toolCalls: toolCalls.map((t) => ({
              id: t.id || null,
              name: t.function.name,
              args: truncateForLog(parseArgs(t.function.arguments), 800),
            })),
            legacyFunctionCall: legacyFunctionCall
              ? {
                  name: legacyFunctionCall.name,
                  args: truncateForLog(
                    parseArgs(legacyFunctionCall.arguments),
                    800,
                  ),
                }
              : null,
          })

          console.log('[calendar-ai] tool-dispatch', {
            round: round + 1,
            toolCalls: toolCalls.map((t) => t.function.name),
            legacyFunctionCall: legacyFunctionCall?.name || null,
          })

          if (!toolCalls.length && !legacyFunctionCall) {
            const content = assistantMessage.content || 'No response from model.'
            textStream.append(content)
            history.push({ role: 'assistant', content })
            logAIInteraction('final-response', {
              threadId: normalizedThreadId,
              round: round + 1,
              content: truncateForLog(content, 1200),
            })
            break
          }

          const executableToolCalls = toolCalls.length
            ? toolCalls
            : legacyFunctionCall
              ? [
                  {
                    function: legacyFunctionCall,
                  },
                ]
              : []

          const executableToolNames = executableToolCalls.map(
            (call) => call.function.name,
          )
          if (
            shouldAskClarificationBeforeMutation(
              question,
              extractedRange,
              executableToolCalls,
            )
          ) {
            const clarificationPrompt = buildClarificationPrompt()
            textStream.append(clarificationPrompt)
            history.push({ role: 'assistant', content: clarificationPrompt })
            logAIInteraction('clarification-required', {
              threadId: normalizedThreadId,
              round: round + 1,
              toolNames: executableToolNames,
              extractedRange,
            })
            break
          }

          if (toolCalls.length) {
            history.push({
              role: 'assistant',
              content: assistantMessage.content || '',
              tool_calls: toolCalls,
            })
          } else if (legacyFunctionCall) {
            history.push({
              role: 'assistant',
              content: assistantMessage.content || '',
              function_call: legacyFunctionCall,
            })
          }

          for (const toolCall of executableToolCalls) {
            logAIInteraction('tool-call-start', {
              threadId: normalizedThreadId,
              round: round + 1,
              toolName: toolCall.function.name,
              args: truncateForLog(parseArgs(toolCall.function.arguments), 800),
            })

            const result = await executeCalendarTool(
              toolCall,
              calendar,
              session.user?.email,
              gui,
            )
            let outputError: string | null = null
            try {
              const parsed = JSON.parse(result.output)
              outputError = parsed?.error || null
            } catch {
              outputError = null
            }
            logAIInteraction('tool-call-result', {
              threadId: normalizedThreadId,
              round: round + 1,
              toolName: toolCall.function.name,
              didMutate: result.didMutate,
              outputError,
              output: truncateForLog(result.output, 1200),
            })

            if (result.didMutate) {
              refetchJobs++
              refetchJobsStream.update(refetchJobs)
            }

            if (toolCalls.length) {
              history.push({
                role: 'tool',
                tool_call_id: toolCall.id || generateId(),
                content: result.output,
              })
            } else {
              history.push({
                role: 'function',
                name: toolCall.function.name,
                content: result.output,
              })
            }
          }
        }

        conversationStore.set(normalizedThreadId, history.slice(-30))
        logAIInteraction('request-complete', {
          threadId: normalizedThreadId,
          historyCount: history.length,
        })
      } catch (error: any) {
        status.update('conversation.error')
        logAIInteraction('request-error', {
          threadId: normalizedThreadId,
          error: truncateForLog(
            { message: error?.message, stack: error?.stack },
            2000,
          ),
        })
        textStream.append(
          `Error: ${error?.message || 'Failed to process the request.'}`,
        )
      } finally {
        status.done()
        textUIStream.done()
        gui.done()
        textStream.done()
        threadIdStream.done()
        refetchJobsStream.done()
        refetchRangeStream.done()
      }
    })().catch(() => {})

    return {
      id: generateId(),
      status: status.value,
      text: textUIStream.value,
      gui: gui.value,
      threadIdStream: threadIdStream.value,
      refetchJobsStream: refetchJobsStream.value,
      refetchRangeStream: refetchRangeStream.value,
    }
  } catch (error: any) {
    return {
      id: generateId(),
      status: 'Failed to submit message',
      text: error.message,
      gui: null,
    }
  }
}

export const AI = createAI({
  actions: { submitMessage },
})
