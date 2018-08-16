// BSD 3-Clause License
//
// Copyright (c) 2018, IBM Corporation
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// * Redistributions of source code must retain the above copyright notice, this
//   list of conditions and the following disclaimer.
//
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
//
// * Neither the name of the copyright holder nor the names of its
//   contributors may be used to endorse or promote products derived from
//   this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import { isNullOrUndefined } from "../utility";

/**
 * `PromiseMap` is a key-value store where the values are `Promise`s.
 * It allows for inspection of the state of owned `Promise`s - whether pending,
 * fulfilled, or rejected - as well as the ability to resolve or reject owned
 * `Promise`s that are pending.
 */
export class PromiseMap<K, V> {
    private promises: Map<K, Promise<V>>;
    private data: Map<K, MapData<V>>;
    private readonly timeout?: number;

    /**
     * @param timeout The duration, in milliseconds, to wait before deleting
     *                settled `Promise`s.
     * @returns An empty `PromiseMap`.
     */
    public constructor(timeout?: number) {
        this.promises = new Map<K, Promise<V>>();
        this.data = new Map<K, MapData<V>>();
        this.timeout = timeout;
    }

    /**
     * @param key The key to check for membership in the owned set.
     * @returns True if this contains the requested key.
     */
    public has(key: K): boolean {
        return this.promises.has(key);
    }

    /**
     * @param key The key of the Promise whose status is to be queried.
     * @returns True if the key is in the owned set and the matching `Promise`
     *          is pending.
     */
    public isPending(key: K): boolean {
        const entry = this.data.get(key);

        return !isNullOrUndefined(entry) && entry.status === State.Pending;
    }

    /**
     * @param key The key of the Promise whose status is to be queried.
     * @returns True if the key is in the owned set and the matching `Promise`
     *          is fulfilled.
     */
    public isFulfilled(key: K): boolean {
        const entry = this.data.get(key);

        return !isNullOrUndefined(entry) && entry.status === State.Fulfilled;
    }

    /**
     * @param key The key of the `Promise` whose status is to be queried.
     * @returns True if the key is in the owned set and the matching `Promise`
     *          is rejected.
     */
    public isRejected(key: K): boolean {
        const entry = this.data.get(key);

        return !isNullOrUndefined(entry) && entry.status === State.Rejected;
    }

    /**
     * The matching `Promise` to `key` will remain pending until `value`
     * resolves. If `value` is a `Promise`-like type, the corresponding
     * `Promise` will follow `value`. If not, the owned `Promise` will be
     * fulfilled.
     *
     * @param key The key of the `Promise` to be settled. Must be pending or
     *            not in the owned set.
     * @param value The value to settle the `Promise` to.
     * @returns True if a new `Promise` was inserted.
     * @throws Error If the matching `Promise` is already settled.
     */
    public resolve(key: K, value: V | PromiseLike<V>): boolean {
        const maybePromiseData = this.getRaw(key);
        const hasEntry = !isNullOrUndefined(maybePromiseData);

        const doResolve = () => Promise.resolve(value)
            .then((resolved) => {
                this.data.set(key, {
                    ...this.data.get(key)!,
                    status: State.Fulfilled,
                });

                return resolved;
            }).catch((reason) => {
                this.data.set(key, {
                    ...this.data.get(key)!,
                    status: State.Rejected,
                });

                return Promise.reject(reason);
            });

        if (!isNullOrUndefined(maybePromiseData)) {
            const data = maybePromiseData[1];

            if (data.status !== State.Pending
                || isNullOrUndefined(data.functions)) {
                throw new Error(`cannot resolve "${key}": already settled`);
            }

            data.functions.resolve(doResolve());

            const { functions, ...resolved } = {
                ...data,
                status: State.Pending,
            };

            this.data.set(key, resolved);
        } else {
            this.promises.set(key, doResolve());
            this.data.set(key, { status: State.Pending });
        }

        this.setTimeout(key);

        return !hasEntry;
    }

    /**
     * @param key The key of the `Promise` to be rejected. Must be pending or
     *            not in the owned set.
     * @param reason The reason to reject the `Promise` with.
     * @returns True if a new `Promise` was inserted.
     * @throws Error If the matching `Promise` is already settled.
     */
    public reject(key: K, reason?: any): boolean {
        const maybePromiseData = this.getRaw(key);
        const hasEntry = !isNullOrUndefined(maybePromiseData);

        if (!isNullOrUndefined(maybePromiseData)) {
            const data = maybePromiseData[1];

            if (data.status !== State.Pending
                || isNullOrUndefined(data.functions)) {
                throw new Error(`cannot reject "${key}": already settled`);
            }

            data.functions.reject(reason);

            const { functions, ...rejected } = {
                ...data,
                status: State.Rejected,
            };

            this.data.set(key, rejected);
        } else {
            this.promises.set(key, Promise.reject(reason));
            this.data.set(key, { status: State.Rejected });
        }

        this.setTimeout(key);

        return !hasEntry;
    }

    /**
     * Rejects all pending `Promise`s that are not following another `Promise`.
     *
     * @param reason The reason to reject any pending `Promise`s with.
     * @returns The number of rejected `Promise`s.
     */
    public rejectAll(reason?: any): number {
        const keys = Array.from(this.data.entries())
            .filter(([_, data]) => data.status === State.Pending
                                   && !isNullOrUndefined(data.functions))
            .map(([key, _]) => key);

        for (const key of keys) {
            this.reject(key, reason);
        }

        return keys.length;
    }

    /**
     * If `key` is not in the owned set, a new `Promise` will be created.
     *
     * @param key The key of the `Promise` to get.
     * @returns The matching `Promise` to the key.
     */
    public get(key: K): Promise<V> {
        const maybePromiseData = this.getRaw(key);

        if (!isNullOrUndefined(maybePromiseData)) {
            return maybePromiseData[0];
        }

        const promise = new Promise<V>((resolve, reject) => this.data.set(key, {
            status: State.Pending,
            functions: { resolve, reject },
        }));

        this.promises.set(key, promise);

        return promise;
    }

    /**
     * @param key The key of the `Promise` to delete.
     * @returns True if `key` and the matching `Promise` were in the owned set.
     */
    public delete(key: K): boolean {
        const maybePromiseData = this.getRaw(key);

        if (isNullOrUndefined(maybePromiseData)) {
            return false;
        }

        const data = maybePromiseData[1];

        if (!isNullOrUndefined(data.functions)) {
            data.functions.reject(new Error("deleted"));
        }

        if (!isNullOrUndefined(data.timer)) {
            clearTimeout(data.timer);
        }

        this.promises.delete(key);
        this.data.delete(key);

        return true;
    }

    /**
     * @returns The number of `Promise`s that were deleted.
     */
    public clear(): number {
        const keys = Array.from(this.promises.keys());

        for (const key of keys) {
            this.delete(key);
        }

        return keys.length;
    }

    private setTimeout(key: K): boolean {
        const maybeData = this.data.get(key);

        if (isNullOrUndefined(maybeData) || isNullOrUndefined(this.timeout)) {
            return false;
        }

        const data = maybeData;

        if (!isNullOrUndefined(data.timer)) {
            clearTimeout(data.timer);
        }

        this.data.set(key, {
            ...data,
            timer: setTimeout(() => this.delete(key), this.timeout),
        });

        return true;
    }

    private getRaw(key: K): [Promise<V>, MapData<V>] | undefined {
        const maybePromise = this.promises.get(key);
        const maybeData = this.data.get(key);

        if (isNullOrUndefined(maybePromise) && isNullOrUndefined(maybeData)) {
            return undefined;
        } else if (isNullOrUndefined(maybePromise)) {
            throw new Error(`promise is undefined for "${key}"`);
        } else if (isNullOrUndefined(maybeData)) {
            throw new Error(`data is undefined for "${key}"`);
        }

        return [maybePromise, maybeData];
    }
}

enum State {
    Pending,
    Fulfilled,
    Rejected,
}

interface MapData<T> {
    readonly functions?: PromiseFunctions<T>;
    readonly status: State;
    readonly timer?: NodeJS.Timer;
}

interface PromiseFunctions<T> {
    reject(reason?: any): void;
    resolve(message?: T | PromiseLike<T>): void;
}