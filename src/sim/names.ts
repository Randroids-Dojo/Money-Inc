import type { Rng } from './rng';
import type { Sector } from './types';

const SURNAMES = [
  'Okafor', 'Lindqvist', 'Moreno', 'Nakamura', 'Patel', 'Hughes', 'Kowalski', 'Adeyemi', 'Fontaine', 'Brennan',
  'Castillo', 'Haddad', 'Novak', 'Osei', 'Ramirez', 'Schmidt', 'Tanaka', 'Walsh', 'Yilmaz', 'Zhou',
  'Abernathy', 'Bellweather', 'Calloway', 'Delacroix', 'Ellison', 'Fairbanks', 'Garrity', 'Holloway', 'Iverson', 'Jaramillo',
  'Kingsley', 'Lambert', 'Mbeki', 'Nguyen', "O'Hara", 'Petrov', 'Quintero', 'Rasmussen', 'Silva', 'Thorne',
  'Underwood', 'Vasquez', 'Whitfield', 'Xu', 'Yates', 'Zimmer', 'Ahmadi', 'Bishop', 'Chen', 'Dubois',
  'Eriksen', 'Ferreira', 'Grant', 'Hale', 'Ibarra', 'Jensen', 'Keller', 'Lopez', 'Mercer', 'Nash',
  'Oduya', 'Park', 'Reyes', 'Stone', 'Tran', 'Ueda', 'Vance', 'Wong', 'Young', 'Zeller',
  'Arden', 'Baptiste', 'Carver', 'Dunmore', 'Everly', 'Finch', 'Goldberg', 'Harlow', 'Ingram', 'Joshi',
  'Kaur', 'Lowell', 'Marsh', 'Norwood', 'Olsen', 'Pryce', 'Quigley', 'Rowe', 'Sato', 'Tate',
];

export function familyName(rng: Rng): string {
  return `The ${rng.pick(SURNAMES)} family`;
}

const PREFIX = ['Sunny', 'Golden', 'Maple', 'River', 'Oak', 'Harbor', 'Blue', 'Red Door', 'Corner', 'Main St.', 'Elm', 'Union', 'Liberty', 'Pioneer', 'Summit', 'Cedar', 'Lucky', 'Old Town', 'Northside', 'Keystone'];

const BY_SUBTYPE: Record<string, string[]> = {
  grocery: ['Grocers', 'Market', 'Fresh Foods', 'Pantry'],
  clothing: ['Outfitters', 'Threads', 'Boutique', 'Apparel'],
  electronics: ['Electronics', 'Gadgets', 'Radio & TV', 'Tech Shop'],
  hardware: ['Hardware', 'Tools', 'Supply Co.', 'Hardware & Paint'],
  furniture: ['Furniture', 'Home Goods', 'Interiors', 'Sofa Mart'],
  pharmacy: ['Pharmacy', 'Drugstore', 'Apothecary', 'Chemists'],
  bakery: ['Bakery', 'Bakehouse', 'Bread Co.', 'Patisserie'],
  books: ['Books', 'Bookshop', 'Pages', 'Readers'],
  department: ['Department Store', 'Emporium', 'Mercantile'],
  supermarket: ['Supermarket', 'Superstore', 'Food Hall'],
  diner: ['Diner', 'Grill', 'Eats', 'Lunch Counter'],
  cafe: ['Café', 'Coffee House', 'Roasters', 'Tea Room'],
  clinic: ['Clinic', 'Health Center', 'Dental', 'Family Doctors'],
  cinema: ['Cinema', 'Picture House', 'Theatre', 'Movie Palace'],
  gym: ['Gym', 'Fitness', 'Athletic Club', 'Boxing Club'],
  salon: ['Barbers', 'Salon', 'Hair Studio', 'Beauty Parlor'],
  restaurant: ['Bistro', 'Trattoria', 'Kitchen', 'Steakhouse'],
  lawoffice: ['Law Offices', 'Legal Group', 'Attorneys', 'Accountants'],
  insurance: ['Insurance', 'Mutual Assurance', 'Insurance Group'],
  agency: ['Advertising', 'Agency', 'Media Co.', 'Consulting'],
  tech: ['Software', 'Systems', 'Data Co.', 'Labs'],
  textiles: ['Textile Mill', 'Weaving Co.', 'Garment Works'],
  steel: ['Steel Works', 'Foundry', 'Iron Works', 'Metalworks'],
  food: ['Canning Co.', 'Food Works', 'Packing Co.', 'Mills'],
  chemicals: ['Chemical Co.', 'Paints & Dyes', 'Plastics'],
  builder: ['Builders', 'Construction', 'Brick & Beam', 'Contractors'],
};

const FACTORY_ELECTRONICS = ['Electric Works', 'Radio Mfg.', 'Circuits Inc.'];
const FACTORY_FURNITURE = ['Furniture Works', 'Woodworks', 'Cabinet Co.'];

export function firmName(rng: Rng, sector: Sector, subtype: string, city: string): string {
  let tails = BY_SUBTYPE[subtype] ?? ['Co.'];
  if (sector === 'factory' && subtype === 'electronics') tails = FACTORY_ELECTRONICS;
  if (sector === 'factory' && subtype === 'furniture') tails = FACTORY_FURNITURE;
  const r = rng.next();
  let head: string;
  if (r < 0.4) head = rng.pick(SURNAMES);
  else if (r < 0.55 && sector !== 'retail') head = city.split(' ')[0];
  else head = rng.pick(PREFIX);
  const tail = rng.pick(tails);
  return r < 0.4 && (sector === 'retail' || sector === 'service') ? `${head}'s ${tail}` : `${head} ${tail}`;
}

export interface BankIdentity {
  name: string;
  short: string;
  color: string;
}

const BANK_POOL: BankIdentity[] = [
  { name: 'First Harbor Bank', short: 'HARBOR', color: '#2f63b8' },
  { name: 'Granite Commercial', short: 'GRANITE', color: '#3c8a5f' },
  { name: 'Crown Mutual', short: 'CROWN', color: '#8d4bb5' },
  { name: 'Sunrise Savings', short: 'SUNRISE', color: '#e0782a' },
  { name: 'Pioneer Trust', short: 'PIONEER', color: '#1f9aa6' },
  { name: 'Keystone National', short: 'KEYSTONE', color: '#b8433a' },
  { name: 'Beacon Federal', short: 'BEACON', color: '#c9a227' },
  { name: 'Evergreen Bank', short: 'EVERGRN', color: '#4f7d2b' },
  { name: 'Lighthouse Credit', short: 'LIGHTHSE', color: '#5a6fcf' },
  { name: 'Copper State Bank', short: 'COPPER', color: '#b86b3c' },
];

export function bankIdentities(): BankIdentity[] {
  return BANK_POOL.slice();
}

export function bankIdentity(rng: Rng, taken: string[]): BankIdentity {
  const free = BANK_POOL.filter((b) => !taken.includes(b.name));
  return free.length ? rng.pick(free) : { name: `Bank No. ${taken.length + 1}`, short: `BANK${taken.length + 1}`, color: '#777777' };
}
