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

const MAX_TOOL_ROUNDS = 8
const conversationStore = new Map<string, any[]>()
let assistantConfigPromise: Promise<{ instructions: string; tools: ToolSchema[] }> | null = null

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

  const response = await openai.chat.completions.create({
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
  })

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

    return {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    }
  } catch {
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

      const eventTimeZone = time_zone || 'America/Los_Angeles'
      const start = new Date(start_time).toISOString()
      const end = new Date(end_time).toISOString()

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
            date: all_day ? start.split('T')[0] : undefined,
            timeZone: eventTimeZone,
          },
          end: {
            dateTime: all_day ? undefined : end,
            date: all_day ? end.split('T')[0] : undefined,
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

      const start = start_time && new Date(start_time).toISOString()
      const end = end_time && new Date(end_time).toISOString()

      const result = await calendar.events.update({
        calendarId: 'primary',
        eventId: event_id,
        requestBody: {
          summary,
          description,
          start: {
            dateTime: all_day ? undefined : start,
            date: all_day ? start.split('T')[0] : undefined,
          },
          end: {
            dateTime: all_day ? undefined : end,
            date: all_day ? end.split('T')[0] : undefined,
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
  } catch (error: any) {
    gui?.update(
      <>
        <p className="flex gap-2 items-center">
          <X size={16} className="text-destructive" />
          Error on taking this action
        </p>
      </>,
    )

    return {
      output: JSON.stringify({ error: error?.message || 'Tool execution failed' }),
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
        status.update('conversation.extract_range')
        const extractedRange = await extractTimeRangeFromQuestion(question)
        refetchRangeStream.update(extractedRange)

        const { instructions, tools } = await loadAssistantConfig()

        const history = [...(conversationStore.get(normalizedThreadId) || [])]
        history.push({ role: 'user', content: question })

        let refetchJobs = 0

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          status.update(`conversation.model_round_${round + 1}`)

          const completion = await openai.chat.completions.create({
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
          })

          const assistantMessage = completion.choices[0]?.message

          if (!assistantMessage) {
            textStream.append('No response from model.')
            break
          }

          const toolCalls = (assistantMessage.tool_calls || []) as ToolCallLike[]
          const legacyFunctionCall = (assistantMessage as any).function_call as
            | { name: string; arguments?: string }
            | undefined
          console.log('[calendar-ai] tool-dispatch', {
            round: round + 1,
            toolCalls: toolCalls.map((t) => t.function.name),
            legacyFunctionCall: legacyFunctionCall?.name || null,
          })

          if (!toolCalls.length && !legacyFunctionCall) {
            const content = assistantMessage.content || 'No response from model.'
            textStream.append(content)
            history.push({ role: 'assistant', content })
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

          const executableToolCalls = toolCalls.length
            ? toolCalls
            : legacyFunctionCall
              ? [
                  {
                    function: legacyFunctionCall,
                  },
                ]
              : []

          for (const toolCall of executableToolCalls) {
            const result = await executeCalendarTool(
              toolCall,
              calendar,
              session.user?.email,
              gui,
            )

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
      } catch (error: any) {
        status.update('conversation.error')
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
