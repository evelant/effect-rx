import type * as Registry from "@effect-rx/rx/Registry"
import * as Result from "@effect-rx/rx/Result"
import type * as Rx from "@effect-rx/rx/Rx"
import * as Equal from "@effect/data/Equal"
import * as Option from "@effect/data/Option"
import type { NoSuchElementException } from "@effect/io/Cause"
import type { Exit } from "@effect/io/Exit"

const constImmediate = { immediate: true }
function constListener(_: any) {}

/** @internal */
export const TypeId: Registry.TypeId = Symbol.for("@effect-rx/rx/Registry") as Registry.TypeId

/** @internal */
export const make = (): Registry.Registry => new RegistryImpl()

class RegistryImpl implements Registry.Registry {
  readonly [TypeId]: Registry.TypeId
  constructor() {
    this[TypeId] = TypeId
  }

  private readonly nodes = new Map<Rx.Rx<any>, Node<any>>()

  batch = (f: (registry: Registry.Registry) => void) => {
    const batchRegistry = new RegistryImpl()
    const batchModified = new Map<Rx.Writable<any, any>, any>()
    batchRegistry.get = <A>(rx: Rx.Rx<A>): A => {
      if (batchRegistry.nodes.has(rx)) {
        return batchRegistry.ensureNode(rx).value()
      } else {
        const value = this.ensureNode(rx)._value ?? this.get(rx)
        batchRegistry.ensureNode(rx).setValue(value)
        return value
      }
    }
    const batchSet = batchRegistry.set
    batchRegistry.set = <R, W>(rx: Rx.Writable<R, W>, value: W): void => {
      batchModified.set(rx, value)
      batchSet(rx, value)
    }

    f(batchRegistry)

    const invalidated = new Set<Node<any>>()
    batchModified.forEach((value, rx) => {
      const node = this.ensureNode(rx)
      node.setValue(batchRegistry.get(rx), true)
      node.children.forEach((child) => invalidated.add(child))
    })
    invalidated.forEach((node) => node.invalidate())
  }

  get = <A>(rx: Rx.Rx<A>): A => {
    return this.ensureNode(rx).value()
  }

  set = <R, W>(rx: Rx.Writable<R, W>, value: W): void => {
    const node = this.ensureNode(rx)
    rx.write(
      this.get,
      this.set,
      node.setValue,
      node.invalidate,
      value
    )
  }

  refresh<A>(rx: Rx.Rx<A> & Rx.Refreshable): void {
    rx.refresh(this.invalidateRx)
  }

  subscribe<A>(rx: Rx.Rx<A>, f: (_: A) => void, options?: { readonly immediate?: boolean }): () => void {
    const node = this.ensureNode(rx)
    if (options?.immediate) {
      f(node.value())
    }
    const remove = node.subscribe(function() {
      f(node._value)
    })
    return () => {
      remove()
      if (node.canBeRemoved) {
        this.scheduleNodeRemoval(node)
      }
    }
  }

  subscribeGetter<A>(rx: Rx.Rx<A>, f: () => void): readonly [get: () => A, unmount: () => void] {
    const node = this.ensureNode(rx)
    function get() {
      return node.value()
    }
    const remove = node.subscribe(f)
    const unmount = () => {
      remove()
      if (node.canBeRemoved) {
        this.scheduleNodeRemoval(node)
      }
    }
    return [get, unmount]
  }

  mount<A>(rx: Rx.Rx<A>) {
    return this.subscribe(rx, constListener, constImmediate)
  }

  ensureNode<A>(rx: Rx.Rx<A>): Node<A> {
    let node = this.nodes.get(rx)
    if (node === undefined) {
      node = this.createNode(rx)
      this.nodes.set(rx, node)
    }
    return node
  }

  createNode<A>(rx: Rx.Rx<A>): Node<A> {
    if (!rx.keepAlive) {
      this.scheduleRxRemoval(rx)
    }
    return new Node(this, rx)
  }

  invalidateRx = <A>(rx: Rx.Rx<A>): void => {
    this.ensureNode(rx).invalidate()
  }

  scheduleRxRemoval(rx: Rx.Rx<any>): void {
    queueMicrotask(() => {
      const node = this.nodes.get(rx)
      if (node !== undefined && node.canBeRemoved) {
        this.removeNode(node)
      }
    })
  }

  scheduleNodeRemoval(node: Node<any>): void {
    queueMicrotask(() => {
      if (node.canBeRemoved) {
        this.removeNode(node)
      }
    })
  }

  removeNode(node: Node<any>): void {
    const parents = node.parents
    this.nodes.delete(node.rx)
    node.remove()
    for (let i = 0; i < parents.length; i++) {
      if (parents[i].canBeRemoved) {
        this.removeNode(parents[i])
      }
    }
  }
}

const enum NodeFlags {
  alive = 1 << 0,
  initialized = 1 << 1,
  waitingForValue = 1 << 2
}

const enum NodeState {
  uninitialized = NodeFlags.alive | NodeFlags.waitingForValue,
  stale = NodeFlags.alive | NodeFlags.initialized | NodeFlags.waitingForValue,
  valid = NodeFlags.alive | NodeFlags.initialized,
  removed = 0
}

class Node<A> {
  constructor(
    readonly registry: RegistryImpl,
    readonly rx: Rx.Rx<A>
  ) {}

  state: NodeState = NodeState.uninitialized
  lifetime: Lifetime<A> | undefined

  parents: Array<Node<any>> = []
  previousParents: Array<Node<any>> | undefined
  children: Array<Node<any>> = []
  listeners: Array<() => void> = []

  get canBeRemoved(): boolean {
    return !this.rx.keepAlive && this.listeners.length === 0 && this.children.length === 0 &&
      this.state !== 0
  }

  _value: A = undefined as any
  value(): A {
    if ((this.state & NodeFlags.waitingForValue) !== 0) {
      this.lifetime = new Lifetime(this)
      const value = this.rx.read(this.lifetime.get, this.lifetime)
      if ((this.state & NodeFlags.waitingForValue) !== 0) {
        this.setValue(value)
      }

      if (this.previousParents) {
        const parents = this.previousParents
        this.previousParents = undefined
        for (let i = 0; i < parents.length; i++) {
          parents[i].removeChild(this)
          if (parents[i].canBeRemoved) {
            this.registry.scheduleNodeRemoval(parents[i])
          }
        }
      }
    }

    return this._value
  }

  valueOption(): Option.Option<A> {
    if ((this.state & NodeFlags.initialized) === 0) {
      return Option.none()
    }
    return Option.some(this._value)
  }

  setValue = (value: A, batch = false): void => {
    if ((this.state & NodeFlags.initialized) === 0) {
      this.state = NodeState.valid
      this._value = value
      this.notify()
      return
    }

    this.state = NodeState.valid
    if (Equal.equals(this._value, value)) {
      return
    }

    this._value = value
    if (!batch) {
      this.invalidateChildren()
    }
    this.notify()
  }

  addParent(parent: Node<any>): void {
    this.parents.push(parent)
    if (this.previousParents !== undefined) {
      const index = this.previousParents.indexOf(parent)
      if (index !== -1) {
        this.previousParents[index] = this.previousParents[this.previousParents.length - 1]
        if (this.previousParents.pop() === undefined) {
          this.previousParents = undefined
        }
      }
    }

    if (parent.children.indexOf(this) === -1) {
      parent.children.push(this)
    }
  }

  removeChild(child: Node<any>): void {
    const index = this.children.indexOf(child)
    if (index !== -1) {
      this.children[index] = this.children[this.children.length - 1]
      this.children.pop()
    }
  }

  invalidate = (): void => {
    if (this.state === NodeState.valid) {
      this.state = NodeState.stale
      this.disposeLifetime()
    }

    // rebuild
    this.value()
  }

  invalidateChildren(): void {
    if (this.children.length === 0) {
      return
    }

    const children = this.children
    this.children = []
    for (let i = 0; i < children.length; i++) {
      children[i].invalidate()
    }
  }

  notify(): void {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i]()
    }
  }

  disposeLifetime(): void {
    if (this.lifetime !== undefined) {
      this.lifetime.dispose()
      this.lifetime = undefined
    }

    if (this.parents.length !== 0) {
      this.previousParents = this.parents
      this.parents = []
    }
  }

  remove() {
    this.state = NodeState.removed

    if (this.lifetime === undefined) {
      return
    }

    this.disposeLifetime()

    if (this.previousParents === undefined) {
      return
    }

    const parents = this.previousParents
    this.previousParents = undefined
    for (let i = 0; i < parents.length; i++) {
      parents[i].removeChild(this)
      if (parents[i].canBeRemoved) {
        this.registry.removeNode(parents[i])
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index !== -1) {
        this.listeners[index] = this.listeners[this.listeners.length - 1]
        this.listeners.pop()
      }
    }
  }
}

class Lifetime<A> implements Rx.Context {
  constructor(
    readonly node: Node<A>
  ) {}

  finalizers: Array<() => void> | undefined
  disposed = false

  addFinalizer(f: () => void): void {
    this.finalizers ??= []
    this.finalizers.push(f)
  }

  get = <A>(rx: Rx.Rx<A>): A => {
    const parent = this.node.registry.ensureNode(rx)
    this.node.addParent(parent)
    return parent.value()
  }

  getResult<E, A>(rx: Rx.Rx<Result.Result<E, A>>): Exit<E | NoSuchElementException, A> {
    return Result.toExit(this.get(rx))
  }

  once<A>(rx: Rx.Rx<A>): A {
    return this.node.registry.get(rx)
  }

  self<A>(): Option.Option<A> {
    return this.node.valueOption() as any
  }

  refresh<A>(rx: Rx.Rx<A> & Rx.Refreshable): void {
    this.node.registry.refresh(rx)
  }

  refreshSelf(): void {
    this.node.invalidate()
  }

  subscribe<A>(rx: Rx.Rx<A>, f: (_: A) => void, options?: {
    readonly immediate?: boolean
  }): void {
    this.addFinalizer(this.node.registry.subscribe(rx, f, options))
  }

  setSelf<A>(a: A): void {
    this.node.setValue(a as any)
  }

  set<R, W>(rx: Rx.Writable<R, W>, value: W): void {
    this.node.registry.set(rx, value)
  }

  dispose(): void {
    this.disposed = true
    if (this.finalizers === undefined) {
      return
    }

    const finalizers = this.finalizers
    this.finalizers = undefined
    for (let i = finalizers.length - 1; i >= 0; i--) {
      finalizers[i]()
    }
  }
}
