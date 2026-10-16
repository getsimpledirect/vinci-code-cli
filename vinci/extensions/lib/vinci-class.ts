/** Resolve the retired class without changing any other provider/model identifier. */
export function canonicalVinciClass(id: string): string {
  return /^(?:vinci\/)?fortissimo$/i.test(id.trim()) ? "forte" : id;
}
