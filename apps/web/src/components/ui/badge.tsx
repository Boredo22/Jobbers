import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// A badge with named colour variants. `cva` (class-variance-authority) maps a
// `variant` prop to a set of classes — the shadcn pattern for typed style
// variants. Add a variant here and TypeScript autocompletes it at call sites.
const badgeVariants = cva(
	"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
	{
		variants: {
			variant: {
				neutral: "border-transparent bg-slate-100 text-slate-700",
				green: "border-transparent bg-green-100 text-green-800",
				red: "border-transparent bg-red-100 text-red-800",
				amber: "border-transparent bg-amber-100 text-amber-800",
				blue: "border-transparent bg-blue-100 text-blue-800",
				outline: "border-slate-300 text-slate-600",
			},
		},
		defaultVariants: { variant: "neutral" },
	},
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> &
	VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<span className={cn(badgeVariants({ variant }), className)} {...props} />
	);
}
