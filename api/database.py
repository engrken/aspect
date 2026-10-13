import os
from sqlalchemy import create_engine, Column, Integer, String, Float, JSON, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime

# Grab your connection string from Vercel Environment Variables
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://user:password@localhost/aspect")

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Relational replacement for your Google Sheets
class Submission(Base):
    __tablename__ = "submissions"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    class_id = Column(String, index=True)
    student_id = Column(String, index=True)
    test_set = Column(String)
    raw_score = Column(Integer)
    total_points = Column(Integer)
    percentage = Column(Float)
    status = Column(String)
    answers = Column(JSON)

# Create tables if they don't exist
Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()