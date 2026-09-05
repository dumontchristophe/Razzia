import { MEDIA_TYPES } from "@razzia/common/constants"
import type { Question, Quizz } from "@razzia/common/types/game"
import { STATUS } from "@razzia/common/types/game/status"
import { RoundManager } from "@razzia/socket/services/game/round-manager"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const pending = () =>
  new Promise<void>(() => {
    // Never settles
  })

const MANAGER_ID = "manager-socket"
const managerSocket = { id: MANAGER_ID } as never
const playerSocket = { id: "player-1" } as never

const makeQuestion = (overrides: Partial<Question> = {}): Question => ({
  type: "single",
  question: "Q?",
  answers: ["a", "b"],
  solutions: [0],
  cooldown: 5,
  time: 15,
  ...overrides,
})

const setup = (question: Question) => {
  const quizz: Quizz = { subject: "s", questions: [question] }
  const broadcast = vi.fn()
  const send = vi.fn()
  const emit = vi.fn()
  const io = { to: vi.fn(() => ({ emit })) } as never

  // The intro cooldown resolves immediately; the answer-phase cooldown never
  // resolves so the assertions stop at SELECT_ANSWER.
  const cooldown = {
    start: vi.fn().mockResolvedValueOnce(undefined).mockReturnValue(pending()),
    abort: vi.fn(),
  } as never

  const players = { count: () => 1, getAll: () => [] } as never

  const round = new RoundManager({
    quizz,
    players,
    cooldown,
    io,
    gameId: "game-1",
    getManagerId: () => MANAGER_ID,
    broadcast,
    send,
    onNewQuestion: vi.fn(),
    onGameFinished: vi.fn(),
  })

  return { round, broadcast }
}

const shownQuestion = (broadcast: ReturnType<typeof vi.fn>) =>
  broadcast.mock.calls.some((c) => c[0] === STATUS.SELECT_ANSWER)

// Drives start() through the intro and the 2s prepared screen up to
// SHOW_QUESTION, leaving the question phase in progress.
const advanceToQuestionPhase = async (round: RoundManager) => {
  void round.start(managerSocket)
  await vi.advanceTimersByTimeAsync(3000)
  await vi.advanceTimersByTimeAsync(2000)
}

describe("RoundManager question phase", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("SHOW_QUESTION carries the full media and its index", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)

    const call = broadcast.mock.calls.find((c) => c[0] === STATUS.SHOW_QUESTION)
    expect(call?.[1]).toMatchObject({ media, questionIndex: 0 })
  })

  it("image question ends at the fixed cooldown and ignores mediaEnded", async () => {
    const media = { type: MEDIA_TYPES.IMAGE, url: "/media/i.png" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)

    round.mediaEnded(managerSocket, 0)
    await vi.advanceTimersByTimeAsync(4000)
    expect(shownQuestion(broadcast)).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)
    expect(shownQuestion(broadcast)).toBe(true)
  })

  it("audio question ends on the manager's mediaEnded, never before cooldown", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)

    await vi.advanceTimersByTimeAsync(2000)
    round.mediaEnded(managerSocket, 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(shownQuestion(broadcast)).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    expect(shownQuestion(broadcast)).toBe(true)
  })

  it("audio question ends at cooldown when mediaEnded arrives after it", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)

    await vi.advanceTimersByTimeAsync(5000)
    expect(shownQuestion(broadcast)).toBe(false)

    round.mediaEnded(managerSocket, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(shownQuestion(broadcast)).toBe(true)
  })

  it("audio question falls back to the cooldown + 120s safety cap", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)

    await vi.advanceTimersByTimeAsync(5000 + 119000)
    expect(shownQuestion(broadcast)).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)
    expect(shownQuestion(broadcast)).toBe(true)
  })

  it("manager skip ends the audio phase after cooldown, not before", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)

    await vi.advanceTimersByTimeAsync(2000)
    round.abortQuestion(managerSocket)
    await vi.advanceTimersByTimeAsync(1000)
    expect(shownQuestion(broadcast)).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    expect(shownQuestion(broadcast)).toBe(true)
  })

  it("manager skip past cooldown moves to SELECT_ANSWER immediately", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)
    await vi.advanceTimersByTimeAsync(5000)

    round.abortQuestion(playerSocket)
    await vi.advanceTimersByTimeAsync(0)
    expect(shownQuestion(broadcast)).toBe(false)

    round.abortQuestion(managerSocket)
    await vi.advanceTimersByTimeAsync(0)
    expect(shownQuestion(broadcast)).toBe(true)
  })

  it("clears the safety cap once the media phase has ended", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)
    await vi.advanceTimersByTimeAsync(5000)
    round.mediaEnded(managerSocket, 0)
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
  })

  it("ignores mediaEnded from a non-manager or a mismatched index", async () => {
    const media = { type: MEDIA_TYPES.AUDIO, url: "/media/a.mp3" }
    const { round, broadcast } = setup(makeQuestion({ media }))

    await advanceToQuestionPhase(round)
    await vi.advanceTimersByTimeAsync(5000)

    round.mediaEnded(playerSocket, 0)
    round.mediaEnded(managerSocket, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(shownQuestion(broadcast)).toBe(false)

    round.mediaEnded(managerSocket, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(shownQuestion(broadcast)).toBe(true)
  })
})
