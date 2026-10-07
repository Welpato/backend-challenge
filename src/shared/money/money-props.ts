/** Formato de dinheiro nos contratos (HTTP, SQS, eventos): `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  /** String decimal com exatamente 2 casas, ex.: `"25.00"`. */
  amount: string;
  /** Código ISO-4217 em maiúsculas, ex.: `"BRL"`. */
  currency: string;
}
