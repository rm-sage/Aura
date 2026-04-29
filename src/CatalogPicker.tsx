export interface CatalogInfo {
  media_type: string;
  id: string;
  name: string;
}

interface Props {
  addonName: string;
  catalogs: CatalogInfo[];
  selected: CatalogInfo | null;
  onSelect: (catalog: CatalogInfo) => void;
}

// Badge showing the media type ("Movie", "Series", …)
function TypeBadge({ type: t }: { type: string }) {
  const label = t.charAt(0).toUpperCase() + t.slice(1);
  return (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded
                     bg-white/8 text-white/45 border border-white/10">
      {label}
    </span>
  );
}

export default function CatalogPicker({ addonName, catalogs, selected, onSelect }: Props) {
  return (
    <div className="flex-shrink-0 border-b border-white/8 px-5 py-3 bg-black/20
                    backdrop-blur-sm overflow-x-auto"
         style={{ scrollbarWidth: "none" }}>
      {/* Addon name */}
      <p className="text-white/40 text-[10px] font-semibold tracking-[0.12em] uppercase mb-2">
        {addonName}
      </p>

      {/* Catalog pills */}
      <div className="flex gap-2 flex-nowrap">
        {catalogs.map((cat) => {
          const isSelected = selected?.id === cat.id && selected?.media_type === cat.media_type;
          return (
            <button
              key={`${cat.media_type}-${cat.id}`}
              onClick={() => onSelect(cat)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                          flex-shrink-0 transition-all duration-150
                          ${isSelected
                            ? "bg-white/15 text-white border border-white/25"
                            : "bg-white/5 text-white/55 border border-white/8 hover:bg-white/10 hover:text-white/80"
                          }`}
            >
              {cat.name}
              <TypeBadge type={cat.media_type} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
