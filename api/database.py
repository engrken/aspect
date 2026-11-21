import os
import hashlib
import hmac
import secrets
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, Boolean, JSON, DateTime, text
from sqlalchemy.orm import declarative_base, sessionmaker

raw_db_url = os.getenv("DATABASE_URL", "").strip()
if not raw_db_url:
    raw_db_url = "sqlite:////tmp/aspect_local.db"
elif raw_db_url.startswith("postgres://"):
    raw_db_url = raw_db_url.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if raw_db_url.startswith("sqlite") else {}
engine = create_engine(raw_db_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def hash_password(password: str, iterations: int = 260000) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${dk.hex()}"

def verify_password(password: str, stored_hash: str) -> bool:
    if not stored_hash or "$" not in stored_hash:
        return False
    try:
        algo, iter_str, salt, hash_hex = stored_hash.split("$")
        iterations = int(iter_str)
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), iterations)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False

class RosterUser(Base):
    __tablename__ = "roster"
    student_id = Column(String, primary_key=True, index=True)
    email = Column(String, default="")
    full_name = Column(String, nullable=False)
    section = Column(String, default="BS-ECE")
    role = Column(String, default="STUDENT")
    password_hash = Column(String, default="")
    must_change_password = Column(Boolean, default=False)

class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token = Column(String, primary_key=True, index=True)
    student_id = Column(String, index=True)
    otp_code = Column(String, nullable=True)
    expires_at = Column(DateTime)


class OTPChallenge(Base):
    __tablename__ = "otp_challenges"
    id = Column(Integer, primary_key=True, autoincrement=True)
    student_id = Column(String, index=True, nullable=False)
    otp_hash = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    attempts = Column(Integer, default=0, nullable=False)
    consumed_at = Column(DateTime, nullable=True)

class CourseClass(Base):
    __tablename__ = "classes"
    class_id = Column(String, primary_key=True, index=True)
    subject_code = Column(String, nullable=False)
    subject_title = Column(String, nullable=False)
    default_section = Column(String, default="BS-ECE 3A")
    active_sets = Column(String, default="A, B")
    passing_percentage = Column(Integer, default=70)
    owner_teacher_id = Column(String, default="FACULTY-01")

class ExamItem(Base):
    __tablename__ = "exam_items"
    id = Column(Integer, primary_key=True, autoincrement=True)
    class_id = Column(String, index=True)
    item_no = Column(Integer)
    type = Column(String, default="MCQ")
    points = Column(Integer, default=1)
    set_a = Column(String, default="A")
    set_b = Column(String, default="A")

class Enrollment(Base):
    __tablename__ = "enrollments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    class_id = Column(String, index=True)
    student_id = Column(String, index=True)

class Submission(Base):
    __tablename__ = "exam_submissions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    class_id = Column(String, index=True)
    student_id = Column(String, index=True)
    full_name = Column(String)
    section = Column(String)
    test_set = Column(String, default="A")
    raw_score = Column(Integer)
    total_points = Column(Integer)
    percentage = Column(Float)
    is_passed = Column(Boolean)
    answers = Column(JSON)
    scanned_image = Column(String, default="")
    item_breakdown = Column(JSON, default=[])

def ensure_seeded(db):
    Base.metadata.create_all(bind=engine)
    
    # Run schema migrations individually so one error doesn't block the rest
    migrations = [
        "ALTER TABLE roster ADD COLUMN IF NOT EXISTS password_hash VARCHAR DEFAULT ''",
        "ALTER TABLE roster ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE",
        "ALTER TABLE exam_submissions ADD COLUMN IF NOT EXISTS scanned_image TEXT DEFAULT ''",
        "ALTER TABLE exam_submissions ADD COLUMN IF NOT EXISTS item_breakdown JSON"
    ]
    
    for query in migrations:
        try:
            db.execute(text(query))
            db.commit()
        except Exception as e:
            db.rollback()
            print(f"Migration skipped: {e}")


def get_db():
    # Create the OTP challenge table lazily on each serverless instance.
    # checkfirst keeps this safe across cold starts and existing deployments.
    OTPChallenge.__table__.create(bind=engine, checkfirst=True)
    db = SessionLocal()
    try:
        if engine.dialect.name == 'sqlite':
            ensure_seeded(db)
        yield db
    finally:
        db.close()


if __name__ == "__main__":
    # Schema changes run from an operator's administrative connection.
    with SessionLocal() as session:
        ensure_seeded(session)
