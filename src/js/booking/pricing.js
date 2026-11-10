// Prislogik för bokningsflödet.
//
// ENDAST verifierade priser används (oktober 2026, uppgivna av Skadevi):
//   Slutstädning (exklusive kök) 2 500 kr, lakan/handdukar 200 kr per person,
//   ved 350 kr, tidig incheckning 500 kr, sen utcheckning 500 kr.
// Grundpriset för boendet beror på vistelsetyp (semester/företag/event enligt
// prissidan) och kan inte beräknas säkert av formuläret — därför visas aldrig
// något totalpris för boendet, endast summan av tillvalen.

export const ADDONS = [
  {
    id: 'slutstad',
    label: 'Slutstädning (exklusive kök)',
    price: 2500,
    unit: 'engångspris',
    note: 'Städningen omfattar inte köket.',
    request: false
  },
  {
    id: 'lakan',
    label: 'Hyra lakan och handdukar',
    price: 200,
    unit: 'per person',
    note: 'Ange hur många personer som behöver lakan och handdukar.',
    request: false,
    perPerson: true
  },
  {
    id: 'ved',
    label: 'Köpa ved',
    price: 350,
    unit: 'engångspris',
    note: 'Ett engångspris per beställning.',
    request: false
  },
  {
    id: 'tidigIncheckning',
    label: 'Tidig incheckning',
    price: 500,
    unit: 'engångspris',
    note: 'Önskemål som behöver bekräftas av Skadevi Herrgård.',
    request: true
  },
  {
    id: 'senUtcheckning',
    label: 'Sen utcheckning',
    price: 500,
    unit: 'engångspris',
    note: 'Önskemål som behöver bekräftas av Skadevi Herrgård.',
    request: true
  }
];

// Rabatter (beslutade av Skadevi): veckorabatt 30 % för vistelser på 7
// nätter eller mer, månadsrabatt 69 % för 28 nätter eller mer. Månadsrabatten
// ersätter veckorabatten när båda uppfylls. Rabatterna gäller boendepriset —
// som ännu inte kan beräknas säkert i formuläret (vistelsetyp avgör grundpriset)
// — och presenteras därför som rabattinfo, aldrig som falska totalsummor.
export const DISCOUNTS = [
  { id: 'veckorabatt', label: 'Veckorabatt', percent: 30, minNights: 7 },
  { id: 'manadsrabatt', label: 'Månadsrabatt', percent: 69, minNights: 28 }
];

// Bästa (största) rabatt som gäller för antalet nätter, eller null.
export function bestDiscount(nights) {
  let best = null;
  for (const discount of DISCOUNTS) {
    if (nights >= discount.minNights && (!best || discount.percent > best.percent)) {
      best = discount;
    }
  }
  return best;
}

// Tillämpar en rabatt på ett grundbelopp (används när boendepris kan beräknas).
export function applyDiscount(baseAmount, discount) {
  if (!discount) return baseAmount;
  return Math.round(baseAmount * (1 - discount.percent / 100));
}

// Tekst för UI: rabatten gäller boendepriset som bekräftas i offerten.
export function discountNote(nights) {
  const discount = bestDiscount(nights);
  if (!discount) return null;
  return `${discount.label} ${discount.percent} % gäller för vistelser på ${discount.minNights} nätter eller fler och dras av från boendepriset i offerten.`;
}

export function formatSek(amount) {
  return `${new Intl.NumberFormat('sv-SE').format(amount)} kr`;
}

// Beräknar prisraderna för valda tillval.
export function addonLines(selection) {
  const lines = [];
  for (const addon of ADDONS) {
    if (!selection[addon.id]) continue;
    const quantity = addon.perPerson ? Math.max(1, Number(selection.linenCount) || 1) : 1;
    lines.push({
      id: addon.id,
      label: addon.perPerson
        ? `${addon.label} (${quantity} pers × ${formatSek(addon.price)})`
        : addon.label,
      amount: addon.price * quantity,
      request: addon.request,
      note: addon.note
    });
  }
  return lines;
}

export function sumAddons(lines) {
  return lines.reduce((total, line) => total + line.amount, 0);
}
