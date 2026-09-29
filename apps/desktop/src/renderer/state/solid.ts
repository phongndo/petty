import { createSignal, onCleanup } from 'solid-js'
import { usePettyStore, type PettyState } from './store'

/** Solid tracks only the selected slice; terminal output never touches this store. */
export function usePetty<T>(select: (state: PettyState) => T): () => T {
  const [value, setValue] = createSignal(select(usePettyStore.getState()))
  const unsubscribe = usePettyStore.subscribe((state) => {
    const next = select(state)
    setValue(() => next)
  })
  onCleanup(unsubscribe)
  return value
}
