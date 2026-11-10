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
