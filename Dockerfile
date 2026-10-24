ARG PYTHON_VERSION=3.12
FROM python:${PYTHON_VERSION}-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY pyproject.toml /tmp/pointsnap/pyproject.toml
COPY README.md /tmp/pointsnap/README.md
COPY pointsnap /tmp/pointsnap/pointsnap
RUN pip install --no-cache-dir /tmp/pointsnap \
    && rm -rf /tmp/pointsnap \
    && useradd --create-home --uid 1000 pointsnap \
    && mkdir /work \
    && chown pointsnap:pointsnap /work

USER pointsnap
WORKDIR /work
ENTRYPOINT ["pointsnap"]
CMD ["--help"]
