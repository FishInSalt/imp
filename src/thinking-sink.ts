/** An opaque, generation-scoped thinking section. */
export interface ThinkingSection {
	append(delta: string): void;
	end(): void;
}

/** Semantic thinking output, independent of terminal presentation. */
export interface ThinkingSink {
	begin(): ThinkingSection;
	setHidden(hidden: boolean): void;
}
