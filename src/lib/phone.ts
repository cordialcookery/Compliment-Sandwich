const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function normalizeUsPhone(input: string) {
  const digits = input.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (input.startsWith("+") && E164_PATTERN.test(input)) {
    return input;
  }

  throw new Error("Please enter a valid phone number.");
}

export function maskPhoneNumber(phone: string) {
  const digits = phone.replace(/\D/g, "");
  const lastFour = digits.slice(-4).padStart(4, "*");
  return `(***) ***-${lastFour}`;
}
