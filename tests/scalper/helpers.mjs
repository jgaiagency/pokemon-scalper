export function memoryStorage(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async readText(path) {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(path);
    },
    async writeText(path, value) {
      files.set(path, value);
    },
    async appendText(path, value) {
      files.set(path, `${files.get(path) ?? ''}${value}`);
    },
  };
}

export function sequenceClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    set: (next) => { value = next; },
    advance: (amount) => { value += amount; },
  };
}
