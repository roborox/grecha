import { Atom } from "@rixio/rxjs-atom/build"
import { Observable, Subscriber, Subscription, BehaviorSubject } from "rxjs"
import { filter, first } from "rxjs/operators"
import { createFulfilledWrapped, createRejectedWrapped, pendingWrapped, Wrapped } from "@rixio/rxjs-wrapped";
import { fromPromise } from "@rixio/rxjs-wrapped/build/operators"
import { Cache, CacheState, idle } from ".";

export class CacheImpl<T> extends BehaviorSubject<Wrapped<T>> implements Cache<T> {
  private _subscription: Subscription | null = null
  private _refCount = 0

  constructor(private readonly _atom: Atom<CacheState<T>>, private readonly _loader: () => Promise<T>) {
    super(pendingWrapped)
    this._onSourceValue = this._onSourceValue.bind(this)
    this.clear = this.clear.bind(this)
  }

  get atom(): Atom<CacheState<T>> {
    return this._atom
  }

  get valueAtom(): Atom<T> {
    // @ts-ignore
    return this._atom.lens("value")
  }

  get(force: boolean = false): Promise<T> {
    if (force) {
      this.clear()
    }
    return getFinalValue(this)
  }

  set(value: T): void {
    this.atom.set(createFulfilledWrapped(value))
  }

  modifyIfFulfilled(updateFn: (currentValue: T) => T): void {
    this.atom.modify(s => {
      if (s.status === "fulfilled") {
        return { ...s, value: updateFn(s.value) }
      } else {
        return s
      }
    })
  }

  clear(): void {
    this.atom.set(idle as CacheState<T>)
  }

  private _onSourceValue(x: CacheState<T>) {
    switch (x.status) {
      case "idle":
        Atom.set(this._atom, fromPromise(this._loader())).subscribe()
        this.next(pendingWrapped)
        break
      case "pending":
        this.next(pendingWrapped)
        break
      case "rejected":
        this.next(createRejectedWrapped(x.error, this.clear))
        break
      case "fulfilled":
        this.next(createFulfilledWrapped(x.value))
    }
  }

  _subscribe(subscriber: Subscriber<Wrapped<T>>): Subscription {
    // tslint:disable-line function-name
    if (!this._subscription) {
      this._subscription = this._atom.subscribe(this._onSourceValue)
    }
    this._refCount = this._refCount + 1

    const sub = new Subscription(() => {
      this._refCount = this._refCount - 1
      if (this._refCount <= 0 && this._subscription) {
        this._subscription.unsubscribe()
        this._subscription = null
      }
    })
    sub.add(super._subscribe(subscriber))
    return sub
  }

  unsubscribe() {
    if (this._subscription) {
      this._subscription.unsubscribe()
      this._subscription = null
    }
    this._refCount = 0

    super.unsubscribe()
  }
}

async function getFinalValue<T>(state$: Observable<Wrapped<T>>): Promise<T> {
  const result = await state$
    .pipe(
      filter(x => x.status === "rejected" || x.status === "fulfilled"),
      first(),
    )
    .toPromise()
  switch (result.status) {
    case "rejected":
      return Promise.reject(result.error)
    case "fulfilled":
      return Promise.resolve(result.value)
    default:
      throw new Error("Never happens")
  }
}