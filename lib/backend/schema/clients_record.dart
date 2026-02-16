import 'dart:async';

import '/backend/algolia/serialization_util.dart';
import '/backend/algolia/algolia_manager.dart';
import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class ClientsRecord extends FirestoreRecord {
  ClientsRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  bool hasName() => _name != null;

  // "surname" field.
  String? _surname;
  String get surname => _surname ?? '';
  bool hasSurname() => _surname != null;

  // "created_time" field.
  DateTime? _createdTime;
  DateTime? get createdTime => _createdTime;
  bool hasCreatedTime() => _createdTime != null;

  // "created_by" field.
  DocumentReference? _createdBy;
  DocumentReference? get createdBy => _createdBy;
  bool hasCreatedBy() => _createdBy != null;

  // "email" field.
  String? _email;
  String get email => _email ?? '';
  bool hasEmail() => _email != null;

  // "phone_number" field.
  String? _phoneNumber;
  String get phoneNumber => _phoneNumber ?? '';
  bool hasPhoneNumber() => _phoneNumber != null;

  // "photo_url" field.
  String? _photoUrl;
  String get photoUrl => _photoUrl ?? '';
  bool hasPhotoUrl() => _photoUrl != null;

  // "paid" field.
  double? _paid;
  double get paid => _paid ?? 0.0;
  bool hasPaid() => _paid != null;

  // "toPay" field.
  double? _toPay;
  double get toPay => _toPay ?? 0.0;
  bool hasToPay() => _toPay != null;

  // "room_number" field.
  String? _roomNumber;
  String get roomNumber => _roomNumber ?? '';
  bool hasRoomNumber() => _roomNumber != null;

  // "start_of_stay" field.
  DateTime? _startOfStay;
  DateTime? get startOfStay => _startOfStay;
  bool hasStartOfStay() => _startOfStay != null;

  // "end_of_stay" field.
  DateTime? _endOfStay;
  DateTime? get endOfStay => _endOfStay;
  bool hasEndOfStay() => _endOfStay != null;

  // "accomodation" field.
  DocumentReference? _accomodation;
  DocumentReference? get accomodation => _accomodation;
  bool hasAccomodation() => _accomodation != null;

  void _initializeFields() {
    _name = snapshotData['name'] as String?;
    _surname = snapshotData['surname'] as String?;
    _createdTime = snapshotData['created_time'] as DateTime?;
    _createdBy = snapshotData['created_by'] as DocumentReference?;
    _email = snapshotData['email'] as String?;
    _phoneNumber = snapshotData['phone_number'] as String?;
    _photoUrl = snapshotData['photo_url'] as String?;
    _paid = castToType<double>(snapshotData['paid']);
    _toPay = castToType<double>(snapshotData['toPay']);
    _roomNumber = snapshotData['room_number'] as String?;
    _startOfStay = snapshotData['start_of_stay'] as DateTime?;
    _endOfStay = snapshotData['end_of_stay'] as DateTime?;
    _accomodation = snapshotData['accomodation'] as DocumentReference?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('clients');

  static Stream<ClientsRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => ClientsRecord.fromSnapshot(s));

  static Future<ClientsRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => ClientsRecord.fromSnapshot(s));

  static ClientsRecord fromSnapshot(DocumentSnapshot snapshot) =>
      ClientsRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static ClientsRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      ClientsRecord._(reference, mapFromFirestore(data));

  static ClientsRecord fromAlgolia(AlgoliaObjectSnapshot snapshot) =>
      ClientsRecord.getDocumentFromData(
        {
          'name': snapshot.data['name'],
          'surname': snapshot.data['surname'],
          'created_time': convertAlgoliaParam(
            snapshot.data['created_time'],
            ParamType.DateTime,
            false,
          ),
          'created_by': convertAlgoliaParam(
            snapshot.data['created_by'],
            ParamType.DocumentReference,
            false,
          ),
          'email': snapshot.data['email'],
          'phone_number': snapshot.data['phone_number'],
          'photo_url': snapshot.data['photo_url'],
          'paid': convertAlgoliaParam(
            snapshot.data['paid'],
            ParamType.double,
            false,
          ),
          'toPay': convertAlgoliaParam(
            snapshot.data['toPay'],
            ParamType.double,
            false,
          ),
          'room_number': snapshot.data['room_number'],
          'start_of_stay': convertAlgoliaParam(
            snapshot.data['start_of_stay'],
            ParamType.DateTime,
            false,
          ),
          'end_of_stay': convertAlgoliaParam(
            snapshot.data['end_of_stay'],
            ParamType.DateTime,
            false,
          ),
          'accomodation': convertAlgoliaParam(
            snapshot.data['accomodation'],
            ParamType.DocumentReference,
            false,
          ),
        },
        ClientsRecord.collection.doc(snapshot.objectID),
      );

  static Future<List<ClientsRecord>> search({
    String? term,
    FutureOr<LatLng>? location,
    int? maxResults,
    double? searchRadiusMeters,
    bool useCache = false,
  }) =>
      FFAlgoliaManager.instance
          .algoliaQuery(
            index: 'clients',
            term: term,
            maxResults: maxResults,
            location: location,
            searchRadiusMeters: searchRadiusMeters,
            useCache: useCache,
          )
          .then((r) => r.map(fromAlgolia).toList());

  @override
  String toString() =>
      'ClientsRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is ClientsRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createClientsRecordData({
  String? name,
  String? surname,
  DateTime? createdTime,
  DocumentReference? createdBy,
  String? email,
  String? phoneNumber,
  String? photoUrl,
  double? paid,
  double? toPay,
  String? roomNumber,
  DateTime? startOfStay,
  DateTime? endOfStay,
  DocumentReference? accomodation,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'name': name,
      'surname': surname,
      'created_time': createdTime,
      'created_by': createdBy,
      'email': email,
      'phone_number': phoneNumber,
      'photo_url': photoUrl,
      'paid': paid,
      'toPay': toPay,
      'room_number': roomNumber,
      'start_of_stay': startOfStay,
      'end_of_stay': endOfStay,
      'accomodation': accomodation,
    }.withoutNulls,
  );

  return firestoreData;
}

class ClientsRecordDocumentEquality implements Equality<ClientsRecord> {
  const ClientsRecordDocumentEquality();

  @override
  bool equals(ClientsRecord? e1, ClientsRecord? e2) {
    return e1?.name == e2?.name &&
        e1?.surname == e2?.surname &&
        e1?.createdTime == e2?.createdTime &&
        e1?.createdBy == e2?.createdBy &&
        e1?.email == e2?.email &&
        e1?.phoneNumber == e2?.phoneNumber &&
        e1?.photoUrl == e2?.photoUrl &&
        e1?.paid == e2?.paid &&
        e1?.toPay == e2?.toPay &&
        e1?.roomNumber == e2?.roomNumber &&
        e1?.startOfStay == e2?.startOfStay &&
        e1?.endOfStay == e2?.endOfStay &&
        e1?.accomodation == e2?.accomodation;
  }

  @override
  int hash(ClientsRecord? e) => const ListEquality().hash([
        e?.name,
        e?.surname,
        e?.createdTime,
        e?.createdBy,
        e?.email,
        e?.phoneNumber,
        e?.photoUrl,
        e?.paid,
        e?.toPay,
        e?.roomNumber,
        e?.startOfStay,
        e?.endOfStay,
        e?.accomodation
      ]);

  @override
  bool isValidKey(Object? o) => o is ClientsRecord;
}
