// Native Medusa 2.22.4 IN province keys; names align with the National Portal of India.
// https://www.india.gov.in/directory/web-directory/state-uts
const states: Record<string, string> = {
  an: "Andaman and Nicobar Islands",
  ap: "Andhra Pradesh",
  ar: "Arunachal Pradesh",
  as: "Assam",
  br: "Bihar",
  ch: "Chandigarh",
  ct: "Chhattisgarh",
  dn: "Dadra and Nagar Haveli and Daman and Diu",
  dl: "Delhi",
  ga: "Goa",
  gj: "Gujarat",
  hr: "Haryana",
  hp: "Himachal Pradesh",
  jk: "Jammu and Kashmir",
  jh: "Jharkhand",
  ka: "Karnataka",
  kl: "Kerala",
  la: "Ladakh",
  ld: "Lakshadweep",
  mp: "Madhya Pradesh",
  mh: "Maharashtra",
  mn: "Manipur",
  ml: "Meghalaya",
  mz: "Mizoram",
  nl: "Nagaland",
  or: "Odisha",
  py: "Puducherry",
  pb: "Punjab",
  rj: "Rajasthan",
  sk: "Sikkim",
  tn: "Tamil Nadu",
  tg: "Telangana",
  tr: "Tripura",
  up: "Uttar Pradesh",
  ut: "Uttarakhand",
  wb: "West Bengal",
}

export function indiaStateName(value: unknown): string {
  const name = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
  const code = name.toLowerCase().replace(/^in-/, "")
  return Object.prototype.hasOwnProperty.call(states, code) ? states[code] : name
}
