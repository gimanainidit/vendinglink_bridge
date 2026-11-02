export const escapeHtml = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const formatMoney = (amount: number, currency?: string): string =>
  currency === 'USD' ? `$${amount.toFixed(2)} USD` : `Rp${amount.toLocaleString('id-ID')}`;
