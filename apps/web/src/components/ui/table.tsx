import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// Thin styled wrappers around the native table elements. Same idea as Card: a
// set of small pieces (Table, TableHeader, TableRow, …) you compose, each just
// forwarding className to the real <table>/<thead>/<tr>/<th>/<td>. Using real
// table elements keeps it accessible and sortable-by-the-browser for free.
export function Table({
	className,
	...props
}: HTMLAttributes<HTMLTableElement>) {
	return (
		<div className="w-full overflow-x-auto">
			<table
				className={cn("w-full caption-bottom text-sm", className)}
				{...props}
			/>
		</div>
	);
}

export function TableHeader({
	className,
	...props
}: HTMLAttributes<HTMLTableSectionElement>) {
	return (
		<thead className={cn("border-slate-200 border-b", className)} {...props} />
	);
}

export function TableBody({
	className,
	...props
}: HTMLAttributes<HTMLTableSectionElement>) {
	return (
		<tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
	);
}

export function TableRow({
	className,
	...props
}: HTMLAttributes<HTMLTableRowElement>) {
	return (
		<tr
			className={cn(
				"border-slate-100 border-b transition-colors hover:bg-slate-50",
				className,
			)}
			{...props}
		/>
	);
}

export function TableHead({
	className,
	...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
	return (
		<th
			className={cn(
				"h-10 px-3 text-left align-middle font-medium text-slate-500",
				className,
			)}
			{...props}
		/>
	);
}

export function TableCell({
	className,
	...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
	return <td className={cn("px-3 py-2 align-middle", className)} {...props} />;
}
