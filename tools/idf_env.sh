# Source this to get idf.py: `source tools/idf_env.sh`
export IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf-v5.5.5}"
export IDF_PYTHON_ENV_PATH="${IDF_PYTHON_ENV_PATH:-$HOME/.espressif/python_env/idf5.5_py3.14_env}"
. "$IDF_PATH/export.sh" >/dev/null
