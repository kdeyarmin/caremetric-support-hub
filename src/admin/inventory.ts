import inventoryCsv from "../../docs/ADMIN_FUNCTION_INVENTORY.csv?raw";

export interface AdminSurface {
  product: string;
  repository: string;
  sourceRevision: string;
  surfaceType: string;
  surface: string;
  sourceFile: string;
  sourceLine: number;
  auditAvailability: string;
  sourceUrl: string;
}

const columns = ["Product", "Repository", "SourceRevision", "SurfaceType", "Surface", "SourceFile", "SourceLine", "HubAvailability", "SourceURL"];

/** Parse the checked-in source inventory, including CSV escaping and Windows line endings. */
export function parseAdminInventory(csv: string): AdminSurface[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const content = csv.replace(/^\uFEFF/, "");

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      record.push(field);
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("The administration inventory has an incomplete quoted field.");
  record.push(field);
  if (record.some((value) => value.length > 0)) records.push(record);
  const header = records.shift();
  if (!header || header.length !== columns.length || columns.some((name, index) => header[index] !== name)) {
    throw new Error("The administration inventory columns are invalid.");
  }

  return records.map((row) => {
    if (row.length !== columns.length || row.some((value) => !value.trim())) {
      throw new Error("The administration inventory contains an incomplete row.");
    }
    const [product, repository, sourceRevision, surfaceType, surface, sourceFile, line, auditAvailability, sourceUrl] = row;
    const sourceLine = Number(line);
    if (!Number.isSafeInteger(sourceLine) || sourceLine < 1 || !/^[a-f0-9]{40}$/.test(sourceRevision)) {
      throw new Error("The administration inventory source reference is invalid.");
    }
    const expectedUrl = `https://github.com/kdeyarmin/${repository}/blob/${sourceRevision}/${sourceFile}#L${sourceLine}`;
    if (sourceUrl !== expectedUrl) throw new Error("The administration inventory source link is invalid.");
    return { product, repository, sourceRevision, surfaceType, surface, sourceFile, sourceLine, auditAvailability, sourceUrl };
  });
}

export function filterAdminInventory(surfaces: AdminSurface[], query: string, product = "all"): AdminSurface[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return surfaces.filter((item) => {
    if (product !== "all" && item.product !== product) return false;
    const searchable = [item.product, item.repository, item.surfaceType, item.surface, item.auditAvailability].join(" ").toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

export const adminInventory = parseAdminInventory(inventoryCsv);
export const adminInventoryProducts = [...new Set(adminInventory.map((item) => item.product))];
