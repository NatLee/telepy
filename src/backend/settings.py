"""
Django settings for backend project.
"""
import os
import sys
from datetime import timedelta
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

print("-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-")

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent # Excepted to be "src" folder.
ROOT_DIR = BASE_DIR.parent # Excepted to be the root folder of the project (telepy) or root dir of container.
DATA_DIR = ROOT_DIR / "data"
print(f"---------- Project DIR: {BASE_DIR}")
print(f"---------- Data DIR: {DATA_DIR}")

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = 'django-insecure-uye!=@*gjois#e#8u*3law8=d4^&5s0sh-w*+r3_%+x5tn$lru'

# ----------------------------- START - DEBUG setting -------------------------------
# SECURITY WARNING: don't run with debug turned on in production!
# DEBUG default is False
DEBUG = os.getenv("DEBUG", "False").lower() == "true"
print(f"---------- Debug mode: {DEBUG}")
# ------------------------------ END - DEBUG setting --------------------------------

REVERSE_SERVER_SSH_PORT = os.getenv("REVERSE_SERVER_SSH_PORT", None)
print(f"---------- Reverse SSH Server Port: {REVERSE_SERVER_SSH_PORT}")
WEB_SERVER_PORT = os.getenv("WEB_SERVER_PORT", None)
print(f"---------- Web Server Port: {WEB_SERVER_PORT}")


ALLOWED_HOSTS = ['*']

# -------------- START - CORS Setting --------------
CORS_ALLOW_ALL_ORIGINS = True
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = [
    "http://127.0.0.1",
    "http://localhost",
    f"http://localhost:{WEB_SERVER_PORT}",
]
# -------------- END - CORS Setting -----------------

# Set Server Domain for CSRF
SERVER_DOMAIN = os.getenv("SERVER_DOMAIN", None)
print(f"---------- Server Domain: {SERVER_DOMAIN}")
if SERVER_DOMAIN:
    CSRF_TRUSTED_ORIGINS.extend(
        [
            f"https://{SERVER_DOMAIN}",
            f"http://{SERVER_DOMAIN}",
        ]
    )

# Remove duplicate
CSRF_TRUSTED_ORIGINS = list(set(CSRF_TRUSTED_ORIGINS))

print(f"---------- Allowed Hosts: {ALLOWED_HOSTS}")
print("---------- CSRF Trusted Origins:\n\t{}".format('\n\t'.join(CSRF_TRUSTED_ORIGINS)))
print("-----------------------------------------------")

# -------------- START - Google Auth Setting --------------
SECURE_REFERRER_POLICY = "no-referrer-when-downgrade"
# SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin-allow-popups"
SECURE_CROSS_ORIGIN_OPENER_POLICY = None
SOCIAL_GOOGLE_CLIENT_ID = os.getenv("SOCIAL_GOOGLE_CLIENT_ID", None)
LOGIN_REDIRECT_URL = "/"
VALID_REGISTER_DOMAINS = ["gmail.com"]

# --------------- END - Google Auth Setting -----------------


# Application definition
INSTALLED_APPS = [
    # websocket
    "daphne",
    "channels",
    "channels_redis",
    # django
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # base
    "rest_framework",
    "drf_yasg",
    # package
    'pyinstrument',
    "corsheaders",
    # apps
    "custom_jwt",
    "custom_auth",
    "login",
    "authorized_keys",
    "reverse_keys",
    "tunnels",
    "logs",
    "web_sftp",
    "user_management",
    "site_settings",
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    "corsheaders.middleware.CorsMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    "pyinstrument.middleware.ProfilerMiddleware",
]

ROOT_URLCONF = 'backend.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]


ASGI_APPLICATION = "backend.asgi.application"

# -------------- START - Swagger Setting --------------

USE_X_FORWARDED_HOST = True

SWAGGER_SETTINGS = {
    "SECURITY_DEFINITIONS": {
        "Token(add prefix `Bearer` yourself)": {
            "type": "apiKey",
            "name": "Authorization",
            "in": "header",
        }
    },
    "LOGIN_URL": "/api/__hidden_admin/login",
    "LOGOUT_URL": "/api/__hidden_admin/logout/?next=/api/__hidden_swagger",
}

# --------------- END - Swagger Setting----------------


# -------------- START - Database Setting --------------
SQLITE_DIR = DATA_DIR / "db.sqlite3"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": SQLITE_DIR,
    }
}
print(f"---------- SQLITE DIR: {SQLITE_DIR}")
# -------------- END - Database Setting --------------


# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]


# Internationalization
LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Taipei"
USE_I18N = True
USE_L10N = True
USE_TZ = True
APPEND_SLASH = False


# Static files (CSS, JavaScript, Images)
STATIC_URL = "api/__hidden_statics/"
STATIC_ROOT = DATA_DIR / "staticfiles"
STATICFILES_DIRS = [
    BASE_DIR / "static",
    # other folders containing static files
]

# Default primary key field type
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

CACHES = {
    'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': 'redis://redis:6379',
    },
}

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [("redis", 6379)],
        },
    },
}

# Default primary key field type
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# -------------- START - Log setting --------------
LOG_ROOT = Path('/logs')
LOG_ROOT.mkdir(exist_ok=True)

LOG_TYPES = ['file', 'database']
for log_type in LOG_TYPES:
    log_type_path = LOG_ROOT / log_type
    log_type_path.mkdir(exist_ok=True)

HANDLERS = {}

for log_type in LOG_TYPES:
    HANDLERS[log_type] = {
        'class': 'common.log.InterceptTimedRotatingFileHandler',
        'filename': f"{LOG_ROOT / log_type / f'{log_type}.log'}",
        'when': "H",
        'interval': 1,
        'backupCount': 1,
        'formatter': 'standard',
        'encoding': 'utf-8',
    }

HANDLERS.update({
    'tunnels': {
        'class': 'logging.StreamHandler',
        'stream': sys.stdout
    }
})

LOGGING = {
    'version': 1,
    'disable_existing_loggers': True,
    'formatters': {
        # LOG格式
        'standard': {
            'format': '[%(asctime)s] [%(filename)s:%(lineno)d] [%(module)s:%(funcName)s] [%(levelname)s] - %(message)s'},
        'simple': {  # 簡單格式
            'format': '%(levelname)s %(message)s'
        }
    },
    'filters': {
    },
    'handlers': HANDLERS,
    'loggers': {
        'django': {
            'handlers': ['file'],
            'propagate': True,
            'level': "INFO"
        },
        'tunnels': {
            'handlers': ['tunnels'],
            'propagate': False,
            'level': "DEBUG"
        }
    }
}

# --------------- END - Log setting ---------------


# ---------------------------- START - REST_FRAMEWORK setting --------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        # 支援使用simplejwt的JWT登入
        "rest_framework_simplejwt.authentication.JWTAuthentication",
        # 支援一般session進行後台登入
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": (
        # restframework的API必須登入才可使用
        "rest_framework.permissions.IsAuthenticated",
    ),
    # 使用JSON來render API而非HTML界面
    "DEFAULT_RENDERER_CLASSES": ("rest_framework.renderers.JSONRenderer",),
}
# ----------------------------- END - REST_FRAMEWORK setting ----------------------------


# -------------- Start - SimpleJWT Setting --------------
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=3600),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=1),
    "ROTATE_REFRESH_TOKENS": False,
    "BLACKLIST_AFTER_ROTATION": False,
    "UPDATE_LAST_LOGIN": False,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": SECRET_KEY,
    "VERIFYING_KEY": None,
    "AUDIENCE": None,
    "ISSUER": None,
    "JWK_URL": None,
    "LEEWAY": 0,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "AUTH_HEADER_NAME": "HTTP_AUTHORIZATION",
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
    "USER_AUTHENTICATION_RULE": "rest_framework_simplejwt.authentication.default_user_authentication_rule",
    "AUTH_TOKEN_CLASSES": ("rest_framework_simplejwt.tokens.AccessToken",),
    "TOKEN_TYPE_CLAIM": "token_type",
    "TOKEN_USER_CLASS": "rest_framework_simplejwt.models.TokenUser",
    "JTI_CLAIM": "jti",
    "SLIDING_TOKEN_REFRESH_EXP_CLAIM": "refresh_exp",
    "SLIDING_TOKEN_LIFETIME": timedelta(minutes=5),
    "SLIDING_TOKEN_REFRESH_LIFETIME": timedelta(days=1),
}
# -------------- END - SimpleJWT Setting --------------


print("-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-*-")
