import * as Registry from "@effect-rx/rx/Registry"
import * as Result from "@effect-rx/rx/Result"
import * as Rx from "@effect-rx/rx/Rx"
import * as Context from "@effect/data/Context"
import * as Hash from "@effect/data/Hash"
import * as Option from "@effect/data/Option"
import * as Effect from "@effect/io/Effect"
import * as Layer from "@effect/io/Layer"
import * as Stream from "@effect/stream/Stream"

describe("Rx", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("get/set", () => {
    const counter = Rx.state(0)
    const r = Registry.make()
    expect(r.get(counter)).toEqual(0)
    r.set(counter, 1)
    expect(r.get(counter)).toEqual(1)
  })

  it("keepAlive false", async () => {
    const counter = Rx.state(0)
    const r = Registry.make()
    r.set(counter, 1)
    expect(r.get(counter)).toEqual(1)
    await new Promise((resolve) => resolve(null))
    expect(r.get(counter)).toEqual(0)
  })

  it("keepAlive true", async () => {
    const counter = Rx.state(0).pipe(
      Rx.keepAlive
    )
    const r = Registry.make()
    r.set(counter, 1)
    expect(r.get(counter)).toEqual(1)
    await new Promise((resolve) => resolve(null))
    expect(r.get(counter)).toEqual(1)
  })

  it("subscribe", async () => {
    const counter = Rx.state(0)
    const r = Registry.make()
    let count = 0
    const cancel = r.subscribe(counter, (_) => {
      count = _
    })
    r.set(counter, 1)
    expect(count).toEqual(1)
    await new Promise((resolve) => resolve(null))

    expect(r.get(counter)).toEqual(1)
    cancel()
    await new Promise((resolve) => resolve(null))
    expect(r.get(counter)).toEqual(0)
  })

  it("runtime", async () => {
    const count = Rx.effect(
      () => Effect.flatMap(Counter, (_) => _.get),
      { runtime: counterRuntime }
    )
    const r = Registry.make()
    const result = r.get(count)
    assert(Result.isSuccess(result))
    expect(result.value).toEqual(1)
  })

  it("runtime multiple", async () => {
    const count = Rx.effect(
      () => Effect.flatMap(Counter, (_) => _.get),
      { runtime: counterRuntime }
    )
    const timesTwo = Rx.effect(
      (_get, ctx) =>
        Effect.gen(function*(_) {
          const counter = yield* _(Counter)
          const multiplier = yield* _(Multiplier)
          yield* _(counter.inc)
          expect(yield* _(ctx.getResult(count))).toEqual(2)
          return yield* _(multiplier.times(2))
        }),
      { runtime: multiplierRuntime }
    )
    const r = Registry.make()
    let result = r.get(timesTwo)
    assert(Result.isSuccess(result))
    expect(result.value).toEqual(4)

    result = r.get(count)
    assert(Result.isSuccess(result))
    expect(result.value).toEqual(2)

    await new Promise((resolve) => resolve(null))

    result = r.get(count)
    assert(Result.isSuccess(result))
    expect(result.value).toEqual(1)
  })

  it("readable derived state", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    const addOne = Rx.readable((get) => get(state) + 1)
    expect(r.get(state)).toEqual(1)
    expect(r.get(addOne)).toEqual(2)
    r.set(state, 2)
    expect(r.get(state)).toEqual(2)
    expect(r.get(addOne)).toEqual(3)
  })

  it("readable multiple dependencies", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    const state2 = Rx.state("a").pipe(Rx.keepAlive)
    const derived = Rx.readable((get) => get(state) + get(state2))
    expect(r.get(derived)).toEqual("1a")
    r.set(state, 2)
    r.set(state2, "b")
    expect(r.get(derived)).toEqual("2b")
  })

  it("derived state from derived state", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    const derived = Rx.readable((get) => get(state) + 1)
    const derived2 = Rx.readable((get) => get(derived) + 1)
    expect(r.get(derived)).toEqual(2)
    expect(r.get(derived2)).toEqual(3)
    r.set(state, 2)
    expect(r.get(derived)).toEqual(3)
    expect(r.get(derived2)).toEqual(4)
  })

  it("doesn't compute readables that have no subscribers", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    let count = 0
    const derived = Rx.readable((get) => {
      count++
      return get(state) + 1
    })
    expect(count).toEqual(0)
    expect(r.get(derived)).toEqual(2)
    expect(count).toEqual(1)
    await new Promise((resolve) => resolve(null))
    r.set(state, 2)
    expect(count).toEqual(1)
  })

  it("batching", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    const state2 = Rx.state("a").pipe(Rx.keepAlive)
    let count = 0
    const derived = Rx.readable((get) => {
      count++
      return get(state) + get(state2)
    })
    expect(r.get(derived)).toEqual("1a")
    expect(count).toEqual(1)
    r.batch(() => {
      r.set(state, 2)
      r.set(state2, "b")
    })
    expect(count).toEqual(2)
    expect(r.get(derived)).toEqual("2b")
  })

  it("nested batch", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    const state2 = Rx.state("a").pipe(Rx.keepAlive)
    let count = 0
    const derived = Rx.readable((get) => {
      count++
      return get(state) + get(state2)
    })
    expect(r.get(derived)).toEqual("1a")
    expect(count).toEqual(1)
    r.batch(() => {
      r.set(state, 2)
      r.batch(() => {
        r.set(state2, "b")
      })
    })
    expect(count).toEqual(2)
    expect(r.get(derived)).toEqual("2b")
  })

  it("read correct updated state in batch", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    const state2 = Rx.state("a").pipe(Rx.keepAlive)
    let count = 0
    const derived = Rx.readable((get) => {
      count++
      return get(state) + get(state2)
    })
    expect(r.get(derived)).toEqual("1a")
    expect(count).toEqual(1)
    r.batch(() => {
      r.set(state, 2)
      expect(r.get(derived)).toEqual("2a")
      r.set(state2, "b")
    })
    expect(count).toEqual(3)
    expect(r.get(derived)).toEqual("2b")
  })

  it("notifies liseners after batch commit", async () => {
    const r = Registry.make()
    const state = Rx.state(1).pipe(Rx.keepAlive)
    const state2 = Rx.state("a").pipe(Rx.keepAlive)
    let count = 0
    const derived = Rx.readable((get) => {
      return get(state) + get(state2)
    })
    r.subscribe(derived, () => {
      count++
    }, { immediate: true })
    r.batch(() => {
      r.set(state, 2)
      expect(r.get(derived)).toEqual("2a")
      r.set(state2, "b")
    })
    expect(count).toEqual(2)
    expect(r.get(derived)).toEqual("2b")
  })

  it("effectFn", async () => {
    const count = Rx.effectFn((n: number) => Effect.succeed(n + 1))
    const r = Registry.make()
    let result = r.get(count)
    assert(Result.isInitial(result))
    r.set(count, 1)
    result = r.get(count)
    assert(Result.isSuccess(result))
    expect(result.value).toEqual(2)
  })

  it("scopedFn", async () => {
    let finalized = 0
    const count = Rx.scopedFn((n: number) =>
      Effect.succeed(n + 1).pipe(
        Effect.zipLeft(
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalized++
            })
          )
        )
      )
    ).pipe(Rx.keepAlive)
    const r = Registry.make()
    let result = r.get(count)
    assert(Result.isInitial(result))

    await new Promise((resolve) => resolve(null))
    expect(finalized).toEqual(0)

    r.set(count, 1)
    result = r.get(count)
    assert(Result.isSuccess(result))
    expect(result.value).toEqual(2)

    r.set(count, 2)
    await new Promise((resolve) => resolve(null))
    expect(finalized).toEqual(1)
  })

  it("stream", async () => {
    const count = Rx.stream(() =>
      Stream.range(0, 3).pipe(
        Stream.tap(() => Effect.sleep(50))
      )
    )
    const r = Registry.make()
    const unmount = r.mount(count)
    let result = r.get(count)
    assert(Result.isInitial(result))

    await vi.advanceTimersByTimeAsync(50)
    result = r.get(count)
    assert(Result.isWaiting(result))
    assert(Result.isSuccess(result.previous))
    assert.deepEqual(result.previous.value, 0)

    await vi.advanceTimersByTimeAsync(50)
    result = r.get(count)
    assert(Result.isWaiting(result))
    assert.deepEqual(Result.value(result), Option.some(1))

    await vi.advanceTimersByTimeAsync(50)
    result = r.get(count)
    assert(Result.isSuccess(result))
    assert.deepEqual(Result.value(result), Option.some(2))

    unmount()
    await new Promise((resolve) => resolve(null))
    result = r.get(count)
    assert(Result.isInitial(result))
  })

  it("streamPull", async () => {
    const count = Rx.streamPull(() =>
      Stream.range(0, 5, 1).pipe(
        Stream.tap(() => Effect.sleep(50))
      )
    ).pipe(Rx.refreshable)
    const r = Registry.make()
    const unmount = r.mount(count)

    let result = r.get(count)
    assert(Result.isWaiting(result))
    assert(Option.isNone(Result.value(result)))

    await vi.advanceTimersByTimeAsync(50)
    result = r.get(count)
    assert(Result.isSuccess(result))
    assert.deepEqual(Result.value(result), Option.some([0]))

    r.set(count, void 0)
    result = r.get(count)
    assert(Result.isWaiting(result))
    assert.deepEqual(Result.value(result), Option.some([0]))

    await vi.advanceTimersByTimeAsync(50)
    result = r.get(count)
    assert(Result.isSuccess(result))
    assert.deepEqual(Result.value(result), Option.some([0, 1]))

    r.refresh(count)
    result = r.get(count)
    assert(Result.isWaiting(result))
    assert.deepEqual(Result.value(result), Option.some([0, 1]))

    await vi.advanceTimersByTimeAsync(50)
    result = r.get(count)
    assert(Result.isSuccess(result))
    assert.deepEqual(Result.value(result), Option.some([0]))

    unmount()
    await new Promise((resolve) => resolve(null))
    result = r.get(count)
    assert(Result.isWaiting(result))
    assert(Option.isNone(Result.value(result)))
  })

  it("family", async () => {
    const r = Registry.make()

    const count = Rx.family((n: number) => Rx.state(n))
    const hash = Hash.hash(count(1))
    assert.strictEqual(count(1), count(1))
    r.set(count(1), 2)
    assert.strictEqual(r.get(count(1)), 2)

    const countKeep = Rx.family((n: number) => Rx.state(n).pipe(Rx.keepAlive))
    assert.strictEqual(countKeep(1), countKeep(1))
    r.get(countKeep(1))
    const hashKeep = Hash.hash(countKeep(1))

    if (global.gc) {
      vi.useRealTimers()
      await new Promise((resolve) => setTimeout(resolve, 0))
      global.gc()
      assert.notEqual(hash, Hash.hash(count(1)))
      assert.strictEqual(hashKeep, Hash.hash(countKeep(1)))
    }
  })

  it("label", async () => {
    expect(
      Rx.state(0).pipe(Rx.withLabel("counter")).label![1]
    ).toMatch(/Rx.test.ts:\d+:\d+/)
  })
})

interface Counter {
  readonly get: Effect.Effect<never, never, number>
  readonly inc: Effect.Effect<never, never, void>
}
const Counter = Context.Tag<Counter>("Counter")
const CounterLive = Layer.sync(Counter, () => {
  let count = 1
  return Counter.of({
    get: Effect.sync(() => count),
    inc: Effect.sync(() => {
      count++
    })
  })
})

interface Multiplier {
  readonly times: (n: number) => Effect.Effect<never, never, number>
}
const Multiplier = Context.Tag<Multiplier>("Multiplier")
const MultiplierLive = Layer.effect(
  Multiplier,
  Effect.gen(function*(_) {
    const counter = yield* _(Counter)
    return Multiplier.of({
      times: (n) => Effect.map(counter.get, (_) => _ * n)
    })
  })
)

const counterRuntime: Rx.RxRuntime<never, Counter> = Rx.runtime(CounterLive)
const multiplierRuntime: Rx.RxRuntime<never, Multiplier | Counter> = Rx.runtime(MultiplierLive, counterRuntime)
