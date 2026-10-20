import type { ContentItem, Product } from "../domain";

export interface KnowledgeCoverage { product: Product; published: number; appSpecific: number; shared: number }

/** Published articles placed in each application, split into app-specific and shared guidance. */
export function knowledgeCoverage(products: Product[], content: ContentItem[]): KnowledgeCoverage[] {
  const articles = content.filter(item => item.kind === "article" && item.status === "published");
  return products.filter(product => product.status !== "retired").map(product => {
    const placed = articles.filter(item => item.productIds.includes(product.id));
    const appSpecific = placed.filter(item => item.productIds.length === 1).length;
    return { product, published: placed.length, appSpecific, shared: placed.length - appSpecific };
  });
}
