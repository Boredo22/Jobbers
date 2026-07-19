import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// cn — the one styling helper every shadcn-style component uses.
//   • clsx joins class names and drops falsy ones (conditional classes).
//   • twMerge resolves Tailwind conflicts so the LAST wins: cn("p-2", "p-4")
//     yields "p-4", not both. That's what lets a component take a `className`
//     prop and override its own defaults predictably.
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
