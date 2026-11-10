/** Serializa execuções por chave (ex.: telefone) dentro de um único processo. */
export class KeyedMutex {
  #tails = new Map();

  async run(key, fn) {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = prev.then(() => gate);
    this.#tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
