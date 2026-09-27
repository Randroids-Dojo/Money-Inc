// Genesis Mode people have first names: at this scale every person is a character.

import type { Rng } from '../rng';

const FIRST = [
  'Alex', 'Mara', 'Jonas', 'Priya', 'Tomas', 'Ines', 'Kofi', 'Hana', 'Rafael', 'Lena',
  'Sami', 'Nadia', 'Owen', 'Yara', 'Felix', 'Amara', 'Luca', 'Rosa', 'Ivan', 'Mei',
  'Diego', 'Freya', 'Omar', 'Clara', 'Bram', 'Leila', 'Ezra', 'Tess', 'Nico', 'Ada',
  'Hugo', 'Zora', 'Mateo', 'Iris', 'Kian', 'Wren', 'Ravi', 'Elsa', 'Tariq', 'June',
  'Pablo', 'Noor', 'Arlo', 'Vera', 'Emil', 'Suki', 'Caleb', 'Lina', 'Otto', 'Maya',
];

const LAST = [
  'Okafor', 'Moreno', 'Lindqvist', 'Nakamura', 'Patel', 'Hughes', 'Kowalski', 'Adeyemi', 'Fontaine', 'Brennan',
  'Castillo', 'Haddad', 'Novak', 'Osei', 'Ramirez', 'Schmidt', 'Tanaka', 'Walsh', 'Yilmaz', 'Zhou',
  'Calloway', 'Delacroix', 'Ellison', 'Fairbanks', 'Holloway', 'Iverson', 'Jaramillo', 'Kingsley', 'Mbeki', 'Nguyen',
  'Petrov', 'Quintero', 'Rasmussen', 'Silva', 'Thorne', 'Vasquez', 'Whitfield', 'Chen', 'Dubois', 'Eriksen',
];

export function personName(rng: Rng, taken?: Set<string>): string {
  for (let i = 0; i < 20; i++) {
    const n = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    if (!taken || !taken.has(n)) return n;
  }
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

/** First name only ("Alex"), for short labels. */
export function firstName(full: string): string {
  return full.split(' ')[0] ?? full;
}
