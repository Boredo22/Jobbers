import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 rounded-md font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:pointer-events-none disabled:opacity-50",
	{
		variants: {
			variant: {
				primary: "bg-slate-900 text-white hover:bg-slate-700",
				outline:
					"border border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
				ghost: "text-slate-700 hover:bg-slate-100",
			},
			size: {
				sm: "h-8 px-3",
				md: "h-9 px-4",
			},
		},
		defaultVariants: { variant: "primary", size: "md" },
	},
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
	return (
		<button
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
