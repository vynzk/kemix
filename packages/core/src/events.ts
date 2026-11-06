import { EventEmitter } from 'node:events'
import type { KemixEvent } from './types'

export class EventBus {
	#emitter = new EventEmitter()

	constructor() {
		this.#emitter.setMaxListeners(100)
	}

	emit(event: KemixEvent) {
		this.#emitter.emit('event', event)
	}

	subscribe(listener: (event: KemixEvent) => void): () => void {
		this.#emitter.on('event', listener)
		return () => this.#emitter.off('event', listener)
	}
}
