import React from "react";

type ModelStatus =
  | "ready"
  | "loading"
  | "downloading"
  | "extracting"
  | "error"
  | "unloaded"
  | "none";

interface ModelStatusButtonProps {
  status: ModelStatus;
  displayText: string;
  isDropdownOpen?: boolean;
  onClick?: () => void;
  showCaret?: boolean;
  showText?: boolean;
  className?: string;
}

const ModelStatusButton: React.FC<ModelStatusButtonProps> = ({
  status,
  displayText,
  isDropdownOpen = false,
  onClick,
  showCaret = true,
  showText = true,
  className = "",
}) => {
  const getStatusColor = (status: ModelStatus): string => {
    switch (status) {
      case "ready":
        return "bg-green-400";
      case "loading":
        return "bg-yellow-400 animate-pulse";
      case "downloading":
        return "bg-logo-primary animate-pulse";
      case "extracting":
        return "bg-orange-400 animate-pulse";
      case "error":
        return "bg-red-400";
      case "unloaded":
        return "bg-mid-gray/60";
      case "none":
        return "bg-red-400";
      default:
        return "bg-mid-gray/60";
    }
  };

  const containerClass = `flex items-center gap-2 transition-colors ${
    onClick ? "hover:text-text/80" : "cursor-default"
  } ${className}`;

  const content = (
    <>
      <div className={`w-2 h-2 rounded-full ${getStatusColor(status)}`} />
      {showText && <span className="max-w-28 truncate">{displayText}</span>}
      {showCaret && (
        <svg
          className={`w-3 h-3 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={containerClass}
        title={`Model status: ${displayText}`}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={containerClass} title={`Model status: ${displayText}`}>
      {content}
    </div>
  );
};

export default ModelStatusButton;
