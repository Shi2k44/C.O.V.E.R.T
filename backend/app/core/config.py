"""
Configuration Settings for C.O.V.E.R.T Backend
"""

from typing import List
from pydantic_settings import BaseSettings
from pydantic import validator


class Settings(BaseSettings):
    """Application settings"""

    # ===== Application =====
    APP_NAME: str = "C.O.V.E.R.T"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    API_V1_PREFIX: str = "/api/v1"

    # ===== Security =====
    SECRET_KEY: str = "CHANGE_THIS_IN_PRODUCTION"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # ===== CORS =====
    CORS_ORIGINS: List[str] = ["http://localhost:5173", "http://localhost:3000", "https://covert-chi.vercel.app", "https://c-o-v-e-r-t.vercel.app"]

    # ===== Database =====
    DATABASE_URL: str = "postgresql+asyncpg://covert_user:covert_password@localhost:5432/covert_db"
    DB_ECHO: bool = False

    # ===== Redis =====
    REDIS_URL: str = "redis://localhost:6379/0"

    # ===== IPFS =====
    IPFS_API_URL: str = "/ip4/127.0.0.1/tcp/5001"
    IPFS_GATEWAY_URL: str = "http://localhost:8080"
    PINATA_API_KEY: str = ""
    PINATA_SECRET_KEY: str = ""
    WEB3_STORAGE_TOKEN: str = ""

    # ===== Blockchain =====
    RPC_URL: str = "http://localhost:8545"
    CHAIN_ID: int = 31337  # Local Anvil
    COMMITMENT_REGISTRY_ADDRESS: str = ""
    DAILY_ANCHOR_ADDRESS: str = ""
    COV_CREDITS_ADDRESS: str = ""
    COVERT_BADGES_ADDRESS: str = ""
    COVERT_PROTOCOL_ADDRESS: str = ""
    AUTOMATION_PRIVATE_KEY: str = ""
    # Comma-separated list of moderator wallet addresses (lowercase).
    # Used to randomly assign one moderator per report at submission time.
    MODERATOR_ADDRESSES: str = "0xa429c534cf66a83bfbfff1163ce4e7c4f907f136,0xe06c3f820586b4e31c001565b4eb9d18fbb0c0c7,0x52e0ec9dcff2ff7082927414cee58f4aac976c03"

    # ===== Rate Limiting =====
    RATE_LIMIT_SUBMISSIONS: int = 10  # per hour
    RATE_LIMIT_GENERAL: int = 100  # per hour

    # ===== File Upload =====
    MAX_FILE_SIZE: int = 100 * 1024 * 1024  # 100 MB
    ALLOWED_EXTENSIONS: List[str] = [".jpg", ".jpeg", ".png", ".pdf", ".mp4", ".zip"]

    # ===== Email (Gmail SMTP) =====
    GMAIL_ADDRESS: str = ""
    GMAIL_APP_PASSWORD: str = ""
    FRONTEND_URL: str = "http://localhost:5173"

    # ===== Routing =====
    FOLLOWUP_DAYS: int = 7  # days between followup emails to non-responsive departments

    # ===== Monitoring =====
    SENTRY_DSN: str = ""
    LOG_LEVEL: str = "INFO"

    @validator("SECRET_KEY")
    def check_secret_key(cls, v, values):
        env = values.get("ENVIRONMENT", "development")
        if env == "production" and v == "CHANGE_THIS_IN_PRODUCTION":
            raise ValueError("SECRET_KEY must be changed from default in production")
        return v

    @validator("CORS_ORIGINS", pre=True)
    def parse_cors_origins(cls, v):
        if isinstance(v, str):
            origins = [origin.strip() for origin in v.split(",")]
        else:
            origins = list(v)
        # Always include production frontend URLs
        for vercel in ["https://covert-chi.vercel.app", "https://c-o-v-e-r-t.vercel.app"]:
            if vercel not in origins:
                origins.append(vercel)
        return origins

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
