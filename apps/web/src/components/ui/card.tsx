import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// A card is just a styled container. Splitting it into Card / CardHeader /
// CardContent is the shadcn convention: small composable pieces you assemble,
// rather than one component with a dozen props. Each is a thin wrapper around a
// <div> that forwards className and children.
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"rounded-lg border border-slate-200 bg-white shadow-sm",
				className,
			)}
			{...props}
		/>
	);
}

export function CardHeader({
	className,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("p-4 pb-2", className)} {...props} />;
}

export function CardContent({
	className,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("p-4 pt-2", className)} {...props} />;
}
