import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, Boolean, JSON, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker

raw_db_url = os.getenv("DATABASE_URL", "sqlite:///./aspect_local.db")
if raw_db_url.startswith("postgres://"):
    raw_db_url = raw_db_url.replace("postgres://", "postgresql://", 1)

engine = create_engine(raw_db_url, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class RosterUser(Base):
    __tablename__ = "roster"
    student_id = Column(String, primary_key=True, index=True)
    email = Column(String, default="")
    full_name = Column(String, nullable=False)
    section = Column(String, default="BS-ECE")
    role = Column(String, default="STUDENT")

class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token = Column(String, primary_key=True, index=True)
    student_id = Column(String, index=True)
    otp_code = Column(String, nullable=True)
    expires_at = Column(DateTime)

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

Base.metadata.create_all(bind=engine)

def seed_initial_data():
    db = SessionLocal()
    try:
        if not db.query(RosterUser).filter_by(student_id="FACULTY-01").first():
            db.add(RosterUser(
                student_id="FACULTY-01",
                email="faculty@filamer.edu.ph",
                full_name="Lead Faculty In-Charge",
                section="College of Engineering",
                role="TEACHER"
            ))
            for i in range(1, 31):
                yr = "1A" if i <= 10 else ("2A" if i <= 20 else "3A")
                s_id = f"2026-{str(i).zfill(4)}"
                db.add(RosterUser(
                    student_id=s_id,
                    email="",
                    full_name=f"Examinee Student {i}",
                    section=f"BS-ECE {yr}",
                    role="STUDENT"
                ))
                if i > 20:
                    db.add(Enrollment(class_id="CLS-001", student_id=s_id))

            db.add(CourseClass(
                class_id="CLS-001",
                subject_code="ECE 312",
                subject_title="Feedback and Control Systems",
                default_section="BS-ECE 3A",
                passing_percentage=70,
                owner_teacher_id="FACULTY-01"
            ))
            db.add(CourseClass(
                class_id="CLS-002",
                subject_code="ECE 321",
                subject_title="Digital Communications",
                default_section="BS-ECE 3B",
                passing_percentage=70,
                owner_teacher_id="FACULTY-01"
            ))
            keys_a = ['A','B','C','D','A','B','C','D','A','B','T','F','T','F','T']
            keys_b = ['C','D','A','B','C','D','A','B','C','D','F','T','F','T','F']
            for idx in range(15):
                db.add(ExamItem(
                    class_id="CLS-001",
                    item_no=idx + 1,
                    type="MCQ" if idx < 10 else "TF",
                    points=1,
                    set_a=keys_a[idx],
                    set_b=keys_b[idx]
                ))
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()

seed_initial_data()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()