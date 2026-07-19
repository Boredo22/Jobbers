import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// A thin shadcn-style wrapper over Radix's Dialog. Radix gives us the hard
// parts for free — focus trapping, Escape-to-close, click-outside, ARIA roles,
// body scroll lock — and we only supply the styling. Re-exporting Root/Trigger/
// Close unchanged lets callers write <Dialog><DialogTrigger/>…</Dialog>.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
	className,
	children,
	...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
	return (
		// Portal renders the overlay + content at the <body> root, so the modal
		// escapes any parent's overflow/stacking context.
		<DialogPrimitive.Portal>
			<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in" />
			<DialogPrimitive.Content
				className={cn(
					"fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-5 shadow-lg focus:outline-none",
					className,
				)}
				{...props}
			>
				{children}
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}

export function DialogTitle({
	className,
	...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			className={cn("font-semibold text-lg", className)}
			{...props}
		/>
	);
}

export function DialogDescription({
	className,
	...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			className={cn("text-slate-500 text-sm", className)}
			{...props}
		/>
	);
}
